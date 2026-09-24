// Kokoro Reader content script. Injected on demand by background.js.
//
// Finds the article in the live page, splits it into sentences mapped to DOM
// Ranges, and plays them one by one through the local Kokoro server while
// highlighting the sentence and word being spoken (CSS Custom Highlight API,
// so the page's DOM is never modified).

(() => {
  if (window.__kokoroReader) return;
  window.__kokoroReader = true;

  // --- constants ---------------------------------------------------------
  const VOICES = {
    "US female": ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_aoede", "af_kore", "af_nova"],
    "US male": ["am_michael", "am_adam", "am_eric", "am_liam", "am_onyx", "am_puck", "am_fenrir"],
    "UK female": ["bf_emma", "bf_isabella", "bf_alice", "bf_lily"],
    "UK male": ["bm_george", "bm_fable", "bm_daniel", "bm_lewis"],
    "Português (BR)": ["pf_dora", "pm_alex", "pm_santa"],
  };
  const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];
  const PREFETCH = 3;              // sentences synthesized ahead of playback
  const MAX_SENTENCE = 350;        // longer sentences are split at commas
  const MIN_SENTENCE = 12;         // shorter fragments merge into the previous one
  const USER_SCROLL_GRACE = 6000;  // ms after a manual scroll before auto-follow resumes

  const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd";
  const SKIP = [
    "nav", "aside", "footer", "form", "button", "select", "textarea",
    "script", "style", "noscript", "svg", "canvas", "video", "audio",
    "[role=navigation]", "[role=complementary]", "[role=banner]",
    "[aria-hidden=true]", "[hidden]", ".kr-host",
  ].join(",");
  // The segmenter ends a sentence after these; "Dr. Smith" should stay whole.
  const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|No|Fig|approx|e\.g|i\.e|U\.S|Sra?|Dra?)\.$/i;
  const SKIP_INLINE ="sup, script, style, noscript, svg, [aria-hidden=true]";

  // --- state -------------------------------------------------------------
  let settings = { voice: "af_heart", speed: 1.1 };
  let sentences = [];   // {text, block, start, end, range, nodes}
  let index = 0;
  let active = false;
  let paused = true;
  let generation = 0;   // bumped on every jump/stop; stale async work checks it
  let ctx = null;
  let current = null;   // {src, t0, words, wi}
  let cache = new Map();
  let userScrolledAt = 0;
  let playedChars = 0, playedSecs = 0;
  let ui = null;
  let rafId = 0;

  // --- messaging ---------------------------------------------------------
  function send(type, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, body }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || "unknown error"));
        resolve(res.data);
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") active ? close() : open();
    if (!active) return;
    if (msg.type === "play-pause") togglePause();
    if (msg.type === "next-sentence") jump(index + 1);
    if (msg.type === "prev-sentence") jump(index - 1);
  });

  // --- article extraction ------------------------------------------------
  function visible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // The element holding the most paragraph text, with credit flowing up to
  // parents and grandparents so wrapped paragraphs still add up.
  function findRoot() {
    const scores = new Map();
    for (const p of document.querySelectorAll("p")) {
      if (p.closest(SKIP)) continue;
      const len = p.textContent.trim().length;
      if (len < 40) continue;
      let el = p.parentElement, weight = 1;
      for (let d = 0; el && d < 3; d++, el = el.parentElement, weight /= 2) {
        scores.set(el, (scores.get(el) || 0) + len * weight);
      }
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    return best || document.body;
  }

  function linkDensity(el, textLen) {
    let linked = 0;
    for (const a of el.querySelectorAll("a")) linked += a.textContent.length;
    return textLen ? linked / textLen : 0;
  }

  // Reference lists, comment threads, "related posts" and the like, which
  // often live inside the article container.
  const NOISE = /\b(references?|reflist|footnotes?|comments?|related|share|sharing|social|newsletter|subscribe|signup|promo|advert|ads|sidebar|navbox|breadcrumbs?|toc|metadata|cookies?|consent|gdpr)\b/i;

  function noisy(el, root) {
    for (let a = el; a && a !== root; a = a.parentElement) {
      if (NOISE.test((a.id || "") + " " + (a.getAttribute("class") || ""))) return true;
    }
    return false;
  }

  // The element with the most text directly inside it (through inline tags):
  // old-school pages like paulgraham.com that separate paragraphs with <br>.
  const INLINE = /^(A|B|I|EM|STRONG|SPAN|FONT|SMALL|U|CODE|MARK|Q|CITE|ABBR|S)$/;
  function findTextContainer() {
    const scores = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.data.trim().length;
      if (!len) continue;
      let el = n.parentElement;
      while (el && INLINE.test(el.tagName) && el.parentElement) el = el.parentElement;
      if (el.closest(SKIP) || el.matches(BLOCKS)) continue;
      scores.set(el, (scores.get(el) || 0) + len);
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    return [best, bestScore];
  }

  // Split a container's children into paragraphs at runs of 2+ <br>.
  function brBlocks(container) {
    const groups = [];
    let cur = [], brs = 0;
    const flush = () => { if (cur.length) groups.push(cur); cur = []; };
    const visit = (parent) => {
      for (const child of parent.childNodes) {
        if (child.nodeName === "BR") { if (++brs >= 2) flush(); continue; }
        if (child.nodeType === Node.TEXT_NODE && !child.data.trim()) continue;
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.matches(SKIP)) continue;
          if (child.matches(BLOCKS + ",div,table,center")) {
            flush(); brs = 0;
            if (child.querySelector("br")) visit(child);
            else groups.push([child]);
            flush();
            continue;
          }
          // Inline wrappers such as <font> may themselves hold the <br>s.
          if (INLINE.test(child.tagName) && child.querySelector("br")) { brs = 0; visit(child); continue; }
        }
        brs = 0;
        cur.push(child);
      }
    };
    visit(container);
    flush();
    return groups;
  }

  // Each block is a list of top-level nodes, usually a single element.
  function collectBlocks() {
    const root = findRoot();
    const blocks = [];
    let covered = 0;
    for (const el of root.querySelectorAll(BLOCKS)) {
      if (el.closest(SKIP) || el.querySelector(BLOCKS)) continue;   // take the innermost block
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (text.length < 2 || !visible(el) || noisy(el, root)) continue;
      if (text.length < 120 && linkDensity(el, text.length) > 0.8) continue;  // menus, tag lists
      blocks.push([el]);
      covered += text.length;
    }

    const [container, directLen] = findTextContainer();
    if (container && directLen > 800 && directLen > covered * 2) {
      blocks.length = 0;
      blocks.push(...brBlocks(container));
    }

    // The title usually sits outside the body container; read it first.
    const first = blocks[0]?.[0];
    const h1 = [...document.querySelectorAll("h1")].find((h) => visible(h) && !h.closest(SKIP));
    if (h1 && first && !blocks.some((b) => b.some((n) => n === h1 || n.contains?.(h1))) &&
        (h1.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      blocks.unshift([h1]);
    }
    return blocks;
  }

  // Text nodes of a block with their offsets in the block's concatenated text.
  function textNodes(block) {
    const nodes = [];
    let text = "";
    const add = (n) => {
      if (n.parentElement?.closest(SKIP_INLINE)) return;
      nodes.push({ node: n, start: text.length });
      text += n.data;
    };
    for (const top of block) {
      if (top.nodeType === Node.TEXT_NODE) { add(top); continue; }
      const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) add(n);
    }
    return { nodes, text };
  }

  function blockElement(block) {
    const top = block[0];
    return top.nodeType === Node.ELEMENT_NODE ? top : top.parentElement;
  }

  // A start offset on a node boundary belongs to the next node, an end offset
  // to the previous one, so ranges never begin or end on an empty edge.
  function locate(nodes, offset, isStart) {
    for (const n of nodes) {
      const end = n.start + n.node.data.length;
      if (isStart ? offset < end : offset <= end) return [n.node, Math.max(0, offset - n.start)];
    }
    const last = nodes[nodes.length - 1].node;
    return [last, last.data.length];
  }

  function makeRange(nodes, start, end) {
    const r = document.createRange();
    r.setStart(...locate(nodes, start, true));
    r.setEnd(...locate(nodes, end, false));
    return r;
  }

  // Split an over-long sentence at commas/semicolons (or spaces) for latency.
  function splitLong(start, end, text) {
    const out = [];
    while (end - start > MAX_SENTENCE) {
      const slice = text.slice(start, start + MAX_SENTENCE);
      let cut = Math.max(slice.lastIndexOf("; "), slice.lastIndexOf(", "));
      if (cut < 100) cut = slice.lastIndexOf(" ");
      if (cut < 50) cut = MAX_SENTENCE - 1;
      out.push([start, start + cut + 1]);
      start += cut + 1;
      while (start < end && /\s/.test(text[start])) start++;
    }
    if (end > start) out.push([start, end]);
    return out;
  }

  function buildSentences() {
    const lang = document.documentElement.lang || "en";
    let segmenter;
    try { segmenter = new Intl.Segmenter(lang, { granularity: "sentence" }); }
    catch { segmenter = new Intl.Segmenter("en", { granularity: "sentence" }); }

    const out = [];
    for (const block of collectBlocks()) {
      const { nodes, text } = textNodes(block);
      if (!nodes.length) continue;
      const spans = [];
      // Newlines inside a paragraph are hard wraps, not sentence ends; the
      // replacement keeps every offset intact.
      for (const seg of segmenter.segment(text.replace(/\s/g, " "))) {
        let s = seg.index, e = seg.index + seg.segment.length;
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        if (e <= s || !/[\p{L}\p{N}]/u.test(text.slice(s, e))) continue;
        const last = spans[spans.length - 1];
        const short = last && (e - s < MIN_SENTENCE || last[1] - last[0] < MIN_SENTENCE);
        if (last && (short || ABBREV.test(text.slice(last[0], last[1])))) last[1] = e;
        else spans.push([s, e]);
      }
      for (const [s0, e0] of spans) {
        for (const [s, e] of splitLong(s0, e0, text)) {
          out.push({
            text: text.slice(s, e).replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "").replace(/\s+/g, " "),
            raw: text.slice(s, e),
            block: blockElement(block), nodes, start: s, end: e,
            range: makeRange(nodes, s, e),
          });
        }
      }
    }
    return out;
  }

  // Map Kokoro's word timestamps onto Ranges within the sentence.
  function mapWords(sentence, words) {
    const hay = sentence.raw.toLowerCase();
    const mapped = [];
    let cursor = 0;
    for (const w of words || []) {
      const needle = w.t.toLowerCase();
      const at = hay.indexOf(needle, cursor);
      if (at < 0 || at - cursor > 40) continue;
      const s = sentence.start + at, e = s + needle.length;
      mapped.push({ s: w.s, e: w.e, range: makeRange(sentence.nodes, s, e) });
      cursor = at + needle.length;
    }
    return mapped;
  }

  // --- highlighting & scrolling -----------------------------------------
  const hasHighlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    ::highlight(kr-sentence) { background-color: rgba(255, 214, 10, 0.28); }
    ::highlight(kr-word) { background-color: rgba(255, 170, 0, 0.6); }
  `);

  function highlight(name, range) {
    if (!hasHighlights) return;
    if (range) CSS.highlights.set(name, new Highlight(range));
    else CSS.highlights.delete(name);
  }

  function follow(force = false) {
    const s = sentences[index];
    if (!s) return;
    if (!force && Date.now() - userScrolledAt < USER_SCROLL_GRACE) {
      ui.follow.hidden = false;
      return;
    }
    ui.follow.hidden = true;
    const rect = s.range.getBoundingClientRect();
    if (!force && rect.top > 70 && rect.bottom < innerHeight * 0.72) return;
    const before = scrollY;
    scrollBy({ top: rect.top - innerHeight * 0.3, behavior: "smooth" });
    // Pages that scroll an inner container instead of the window.
    setTimeout(() => {
      if (scrollY === before) s.block.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 120);
  }

  function markUserScroll() { userScrolledAt = Date.now(); if (ui) ui.follow.hidden = false; }
  function onKeyScroll(e) {
    if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "].includes(e.key)) markUserScroll();
  }

  // Alt+click on any sentence jumps there.
  function onClick(e) {
    if (!e.altKey) return;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const node = pos ? pos.offsetNode : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
    const offset = pos ? pos.offset : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset;
    if (!node) return;
    const i = sentences.findIndex((s) => {
      try { return s.range.comparePoint(node, offset) === 0; } catch { return false; }
    });
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    userScrolledAt = 0;
    jump(i, true);
  }

  function startIndex() {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const i = sentences.findIndex((s) => {
        try { return s.range.comparePoint(r.startContainer, r.startOffset) === 0; }
        catch { return false; }
      });
      if (i >= 0) return i;
    }
    // Otherwise, the first sentence visible on screen: start where you are.
    const i = sentences.findIndex((s) => s.range.getBoundingClientRect().bottom > 40);
    return Math.max(0, i);
  }

  // --- audio -------------------------------------------------------------
  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function clip(i) {
    if (!cache.has(i)) {
      const s = sentences[i];
      const p = send("speak", { text: s.text, voice: settings.voice, speed: settings.speed })
        .then(async (data) => ({
          buffer: await ctx.decodeAudioData(b64ToBuffer(data.audio)),
          words: mapWords(s, data.words),
          chars: s.text.length,
        }));
      p.catch(() => cache.delete(i));
      cache.set(i, p);
    }
    return cache.get(i);
  }

  function prefetch() {
    for (let k = 1; k <= PREFETCH; k++) if (index + k < sentences.length) clip(index + k);
    for (const k of cache.keys()) if (k < index - 1 || k > index + PREFETCH + 1) cache.delete(k);
  }

  function stopSource() {
    if (current) {
      current.src.onended = null;
      try { current.src.stop(); } catch {}
      current = null;
    }
    highlight("kr-word", null);
  }

  async function playAt(i) {
    const gen = ++generation;
    stopSource();
    if (i >= sentences.length) return finish();
    index = Math.max(0, i);
    highlight("kr-sentence", sentences[index].range);
    follow();
    render();
    prefetch();

    const pending = clip(index);
    const slow = setTimeout(() => gen === generation && status("Synthesizing…"), 400);
    let c;
    try {
      c = await pending;
    } catch (err) {
      clearTimeout(slow);
      if (gen === generation) fail(err);
      return;
    } finally {
      clearTimeout(slow);
    }
    if (gen !== generation) return;
    status("");

    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    src.playbackRate.value = 1;
    src.connect(ctx.destination);
    src.onended = () => {
      if (gen !== generation) return;
      playedChars += c.chars;
      playedSecs += c.buffer.duration;
      playAt(index + 1);
    };
    current = { src, t0: ctx.currentTime, words: c.words, wi: 0 };
    src.start();
    if (!paused) ensureRunning();
  }

  // Chrome may refuse to start audio until the page has seen a click.
  async function ensureRunning() {
    if (ctx.state === "running") return;
    ctx.resume();
    await new Promise((r) => setTimeout(r, 300));
    if (ctx.state !== "running" && !paused) {
      paused = true;
      render();
      status("Chrome needs one click: press ▶ to start.");
    }
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!current || !current.words.length) return;
    const t = ctx.currentTime - current.t0;
    const words = current.words;
    let wi = current.wi;
    while (wi < words.length - 1 && t >= words[wi + 1].s) wi++;
    if (wi !== current.wi || !current.shown) {
      current.wi = wi;
      current.shown = true;
      highlight("kr-word", t >= words[wi].s - 0.05 ? words[wi].range : null);
    }
  }

  function togglePause() {
    if (index >= sentences.length) {
      paused = false;
      ctx.resume();
      status("");
      return playAt(0);
    }
    paused = !paused;
    if (paused) ctx.suspend();
    else {
      status("");
      ctx.resume();
      if (!current) playAt(index);
    }
    render();
  }

  function jump(i, force = false) {
    if (!sentences.length) return;
    i = Math.min(Math.max(0, i), sentences.length - 1);
    if (force) userScrolledAt = 0;
    playAt(i);
  }

  function finish() {
    stopSource();
    highlight("kr-sentence", null);
    index = sentences.length;
    paused = true;
    render();
    status("Finished. ▶ to start over.");
  }

  function fail(err) {
    paused = true;
    ctx.suspend();
    render();
    const msg = String(err.message || err);
    status(msg === "offline"
      ? "Voice server not running. Run: launchctl kickstart gui/$(id -u)/com.kokoro-reader.server"
      : "Error: " + msg);
  }

  function changeSetting(key, value) {
    settings[key] = value;
    chrome.storage.sync.set({ [key]: value });
    // Keep the sentence being spoken; re-synthesize everything after it.
    for (const k of [...cache.keys()]) if (k !== index) cache.delete(k);
    prefetch();
    if (key === "voice") send("warm", { voice: value }).catch(() => {});
  }

  // --- UI ------------------------------------------------------------------
  const CSS_UI = `
    :host { all: initial; }
    .bar {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 2147483647; display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; border-radius: 14px;
      background: rgba(28, 28, 30, 0.92); color: #f5f5f7;
      font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.3); backdrop-filter: blur(12px);
      max-width: calc(100vw - 32px); flex-wrap: wrap; justify-content: center;
    }
    button, select {
      font: inherit; color: inherit; background: rgba(255,255,255,.08);
      border: 0; border-radius: 8px; padding: 6px 9px; cursor: pointer;
    }
    button:hover, select:hover { background: rgba(255,255,255,.18); }
    button.play { min-width: 38px; font-size: 15px; background: #ffd60a; color: #1c1c1e; }
    select option, select optgroup { color: #1c1c1e; }
    .meta { opacity: .75; font-variant-numeric: tabular-nums; padding: 0 4px; white-space: nowrap; }
    .status { flex-basis: 100%; text-align: center; font-size: 12px; color: #ffd60a; }
    .status:empty { display: none; }
    [hidden] { display: none !important; }
  `;

  function el(tag, props = {}, children = []) {
    const e = Object.assign(document.createElement(tag), props);
    for (const c of children) e.append(c);
    return e;
  }

  function buildUI() {
    const host = el("div", { className: "kr-host" });
    const shadow = host.attachShadow({ mode: "open" });
    const style = new CSSStyleSheet();
    style.replaceSync(CSS_UI);
    shadow.adoptedStyleSheets = [style];

    const voice = el("select", { title: "Voice" });
    for (const [group, names] of Object.entries(VOICES)) {
      const og = el("optgroup", { label: group });
      for (const n of names) og.append(el("option", { value: n, textContent: n.split("_")[1] }));
      voice.append(og);
    }
    voice.value = settings.voice;
    voice.onchange = () => changeSetting("voice", voice.value);

    const speed = el("select", { title: "Speed" });
    for (const s of SPEEDS) speed.append(el("option", { value: s, textContent: s + "×" }));
    speed.value = settings.speed;
    speed.onchange = () => changeSetting("speed", parseFloat(speed.value));

    const btn = (text, title, fn, cls = "") => el("button", { textContent: text, title, onclick: fn, className: cls });
    const play = btn("▶", "Play / pause (Alt+Shift+P)", togglePause, "play");
    const followBtn = btn("⌖ Follow", "Scroll back to the voice", () => { userScrolledAt = 0; follow(true); });
    followBtn.hidden = true;
    const meta = el("span", { className: "meta" });
    const statusEl = el("div", { className: "status" });

    const bar = el("div", { className: "bar" }, [
      btn("⏮", "Previous sentence (Alt+Shift+←)", () => jump(index - 1, true)),
      play,
      btn("⏭", "Next sentence (Alt+Shift+→)", () => jump(index + 1, true)),
      speed, voice, meta, followBtn,
      btn("✕", "Close reader (Alt+Shift+R)", close),
      statusEl,
    ]);
    shadow.append(bar);
    document.documentElement.append(host);
    return { host, play, meta, status: statusEl, follow: followBtn };
  }

  function status(text) { if (ui) ui.status.textContent = text; }

  function render() {
    if (!ui) return;
    ui.play.textContent = paused ? "▶" : "❚❚";
    const n = sentences.length;
    const cps = playedSecs > 20 ? playedChars / playedSecs : 14.5 * settings.speed;
    let left = 0;
    for (let i = index; i < n; i++) left += sentences[i].text.length;
    const mins = Math.ceil(left / cps / 60);
    ui.meta.textContent = `${Math.min(index + 1, n)}/${n} · ${mins} min left`;
  }

  // --- lifecycle -----------------------------------------------------------
  async function open() {
    active = true;
    settings = { ...settings, ...(await chrome.storage.sync.get(["voice", "speed"])) };
    sentences = buildSentences();
    ctx = new AudioContext();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    ui = buildUI();
    addEventListener("wheel", markUserScroll, { passive: true });
    addEventListener("touchmove", markUserScroll, { passive: true });
    addEventListener("keydown", onKeyScroll, true);
    addEventListener("click", onClick, true);
    rafId = requestAnimationFrame(tick);

    if (!sentences.length) {
      render();
      return status("Couldn't find article text on this page.");
    }
    send("warm", { voice: settings.voice }).catch(() => {});
    paused = false;
    userScrolledAt = Date.now();   // don't yank the page on start
    playAt(startIndex());
  }

  function close() {
    active = false;
    generation++;
    stopSource();
    highlight("kr-sentence", null);
    cancelAnimationFrame(rafId);
    removeEventListener("wheel", markUserScroll);
    removeEventListener("touchmove", markUserScroll);
    removeEventListener("keydown", onKeyScroll, true);
    removeEventListener("click", onClick, true);
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    ui?.host.remove();
    ui = null;
    ctx?.close();
    ctx = null;
    cache = new Map();
    sentences = [];
    playedChars = playedSecs = 0;
  }
})();
