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
  const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];
  const PREFETCH = 3;              // sentences synthesized ahead of playback
  const MAX_SENTENCE = 350;        // longer sentences are split at commas
  const MIN_SENTENCE = 12;         // shorter fragments merge into the previous one
  const USER_SCROLL_GRACE = 6000;  // ms after a manual scroll before auto-follow resumes
  const REPLAY_GRACE = 1.5;        // s into a sentence before R restarts it instead of going back

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
  let prefs = KR.DEFAULTS;
  let lang = "en", gender = "female";   // what the current voice was chosen for
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
  function findRoot(title) {
    const scores = new Map(), totals = new Map();
    for (const p of document.querySelectorAll("p")) {
      if (p.closest(SKIP)) continue;
      const len = p.textContent.trim().length;
      if (len < 40) continue;
      let el = p.parentElement, weight = 1;
      for (let d = 0; el && d < 3; d++, el = el.parentElement, weight /= 2) {
        scores.set(el, (scores.get(el) || 0) + len * weight);
      }
      for (el = p.parentElement; el; el = el.parentElement) totals.set(el, (totals.get(el) || 0) + len);
    }
    let best = null, bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
    if (!best) return [document.body, document.body];

    // Articles split into sibling sections (every.to guides) make one section
    // win; climb to an ancestor that holds far more of the page's prose.
    const total = (el) => totals.get(el) || 0;
    const top = (el) => el === document.body || el === document.documentElement;
    // Never past the post's <article>, or comments and recommendations win.
    const article = best.closest("article");
    let root = best;
    for (let a = best.parentElement; a && !top(a) && root !== article; a = a.parentElement) {
      if (total(a) >= 2 * total(root)) root = a;
    }
    // Take in the title and any intro between it and the body, unless that
    // drags in lots of other prose.
    if (title && !root.contains(title)) {
      let a = root.parentElement;
      while (a && !a.contains(title)) a = a.parentElement;
      if (a && !top(a) && total(a) <= 1.25 * total(root)) root = a;
    }
    return [root, best];
  }

  function linkDensity(el, textLen) {
    let linked = 0;
    for (const a of el.querySelectorAll("a")) linked += a.textContent.length;
    return textLen ? linked / textLen : 0;
  }

  // Reference lists, comment threads, "related posts" and the like, which
  // often live inside the article container. Ancestors of the densest prose
  // are exempt: Substack wraps every post in <article class="newsletter-post">.
  const NOISE = /\b(references?|reflist|footnotes?|comments?|related|share|sharing|social|newsletter|subscribe|signup|email-capture|promo|advert|ads|sidebar|navbox|breadcrumbs?|toc|metadata|cookies?|consent|gdpr)\b/i;

  function noisy(el, root, core) {
    for (let a = el; a && a !== root && !a.contains(core); a = a.parentElement) {
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
    // Skip text-less h1s such as Substack's image wordmark in the site header.
    const h1 = [...document.querySelectorAll("h1")]
      .find((h) => visible(h) && !h.closest(SKIP) && h.textContent.trim().length > 1);
    const [root, core] = findRoot(h1);
    const blocks = [];
    let covered = 0;
    for (const el of root.querySelectorAll(BLOCKS)) {
      if (el.closest(SKIP) || el.querySelector(BLOCKS)) continue;   // take the innermost block
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (text.length < 2 || !visible(el) || noisy(el, root, core)) continue;
      if (text.length < 120 && linkDensity(el, text.length) > 0.8) continue;  // menus, tag lists
      blocks.push([el]);
      covered += text.length;
    }

    const [container, directLen] = findTextContainer();
    if (container && directLen > 800 && directLen > covered * 2) {
      blocks.length = 0;
      blocks.push(...brBlocks(container));
    }

    // Breadcrumbs, kickers and dates above the title are not the article.
    const at = h1 ? blocks.findIndex((b) => b[0] === h1) : -1;
    if (at > 0) blocks.splice(0, at);

    // The title usually sits outside the body container; read it first.
    const first = blocks[0]?.[0];
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

  function buildSentences(blocks, lang) {
    let segmenter;
    try { segmenter = new Intl.Segmenter(lang, { granularity: "sentence" }); }
    catch { segmenter = new Intl.Segmenter("en", { granularity: "sentence" }); }

    const out = [];
    for (const block of blocks) {
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

  // --- language, author, voice -------------------------------------------
  const clean = (s) => s.replace(/\s+/g, " ").trim();

  // The page's declared language is often wrong (or just "en"), so the text
  // itself decides when Chrome is sure; the declaration is the runner-up.
  async function detectLanguage(blocks) {
    const sample = clean(blocks.slice(0, 15).map((b) => b.map((n) => n.textContent).join(" ")).join(" ")).slice(0, 1500);
    let code = null;
    if (sample.length > 80) {
      const r = await send("detect-language", { text: sample }).catch(() => null);
      if (r?.reliable && r.languages?.[0]) code = r.languages[0].language.split("-")[0];
    }
    if (code && KR.LANGUAGES[code]) return { lang: code };
    if (code) return { lang: prefs.fallbackLanguage, unsupported: code };
    const declared = (document.documentElement.lang || "").toLowerCase().split("-")[0];
    return { lang: KR.LANGUAGES[declared] ? declared : prefs.fallbackLanguage };
  }

  const PERSON_TYPES = /^(Person)$/i;
  const NOT_A_PERSON = /\b(team|staff|editorial|redação|redacao|equipe|newsroom|reporters?|news|inc|ltd|llc|agency|agência|admin)\b/i;

  function ldAuthors(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { node.forEach((n) => ldAuthors(n, out)); return out; }
    if (node.author) {
      for (const a of [].concat(node.author)) {
        if (typeof a === "string") out.push(a);
        else if (a && (!a["@type"] || PERSON_TYPES.test([].concat(a["@type"])[0])) && a.name) out.push(a.name);
      }
    }
    if (node["@graph"]) ldAuthors(node["@graph"], out);
    return out;
  }

  // The article's first author: metadata first, then structured data, then the
  // byline on the page. Returns null when nothing looks like a person's name.
  function findAuthor() {
    const candidates = [];
    for (const sel of ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="parsely-author"]',
      'meta[name="dc.creator"]', 'meta[name="sailthru.author"]']) {
      for (const m of document.querySelectorAll(sel)) candidates.push(m.content);
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { candidates.push(...ldAuthors(JSON.parse(script.textContent))); } catch {}
    }
    for (const a of document.querySelectorAll(
      '[rel~="author"], [itemprop="author"], [class*="byline"], [class*="author-name"], [class*="authorName"], .author')) {
      if (!a.closest(SKIP) || a.closest("header, article")) candidates.push(a.getAttribute("content") || a.textContent);
    }
    for (const raw of candidates) {
      if (typeof raw !== "string") continue;
      // "By Ana Silva and Bob Lee", "Ana Silva | Feb 3", "Por Ana Silva, editora".
      const name = clean(raw).replace(/^(by|por|par|de|di)\s+/i, "").split(/\s*(?:,|;|\||·|•|—|–| and | e | y | et | & |\n)\s*/i)[0];
      if (/^https?:/i.test(name) || name.length < 3 || name.length > 60) continue;
      if (!/^\p{L}[\p{L}'.\- ]+$/u.test(name) || NOT_A_PERSON.test(name)) continue;
      return name;
    }
    return null;
  }

  // Language from the text, gender from the author; each falls back to the
  // preference. Returns what to say about it too.
  async function chooseForArticle(blocks) {
    let notes = [];
    let picked = { lang: prefs.fallbackLanguage };
    if (prefs.autoLanguage) {
      picked = await detectLanguage(blocks);
      if (picked.unsupported) notes.push(`"${picked.unsupported}" isn't available, using ${KR.LANGUAGES[picked.lang].label}`);
    }
    let g = prefs.fallbackGender;
    if (prefs.autoGender) {
      const author = findAuthor();
      const guessed = author && KRNames.guess(author, picked.lang);
      if (guessed) { g = guessed; notes.push(`${author}: ${guessed} voice`); }
      else if (author) notes.push(`${author}: unsure, using the default voice`);
    }
    return { lang: picked.lang, gender: g, notes };
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

  // Single-key shortcuts while the bar is open. Typing in the page (or in the
  // bar's selects) and modifier chords are left alone.
  function editable(e) {
    const t = e.composedPath()[0];
    return t instanceof Element &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute("role") === "textbox");
  }

  function onKey(e) {
    if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "].includes(e.key)) markUserScroll();
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || editable(e)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = {
      k: togglePause,
      ArrowLeft: () => e.shiftKey ? prevParagraph() : jump(index - 1, true),
      j: () => e.shiftKey ? prevParagraph() : jump(index - 1, true),
      ArrowRight: () => e.shiftKey ? nextParagraph() : jump(index + 1, true),
      l: () => e.shiftKey ? nextParagraph() : jump(index + 1, true),
      r: replay,
      h: () => jump(startIndex(), true),
      f: () => { userScrolledAt = 0; follow(true); },
      "-": () => stepSpeed(-1),
      "_": () => stepSpeed(-1),
      "+": () => stepSpeed(1),
      "=": () => stepSpeed(1),
      "?": toggleHelp,
      Escape: ui && !ui.help.hidden ? toggleHelp : null,
    }[k];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) action();
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
    if (ui?.status.textContent === "Synthesizing…") status("");

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

  // Restart the sentence being read; right after one begins, the one before
  // it is what you missed.
  function replay() {
    const elapsed = current ? ctx.currentTime - current.t0 : 0;
    jump(elapsed > REPLAY_GRACE || index >= sentences.length ? index : index - 1, true);
  }

  function nextParagraph() {
    const at = Math.min(index, sentences.length - 1);
    const i = sentences.findIndex((s, j) => j > at && s.block !== sentences[at].block);
    jump(i < 0 ? sentences.length - 1 : i, true);
  }

  // Back to the start of this paragraph, or of the previous one if already there.
  function prevParagraph() {
    const blockStart = (j) => { while (j > 0 && sentences[j - 1].block === sentences[j].block) j--; return j; };
    const at = Math.min(index, sentences.length - 1);
    const start = blockStart(at);
    jump(start < at ? start : blockStart(Math.max(0, start - 1)), true);
  }

  function stepSpeed(dir) {
    let i = SPEEDS.indexOf(settings.speed);
    if (i < 0) i = SPEEDS.findIndex((s) => s >= settings.speed);
    const next = SPEEDS[Math.min(Math.max(0, i + dir), SPEEDS.length - 1)];
    if (next === settings.speed) return;
    changeSetting("speed", next);
    if (ui) ui.speed.value = next;
    flash(`Speed ${next}× from the next sentence`);
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

  // Picking a voice by hand also makes it the preferred one for its language
  // and gender; switching language only loads that language's preferred voice.
  function chooseVoice(voice, remember = true) {
    lang = KR.langOf(voice);
    gender = KR.genderOf(voice);
    if (remember) {
      prefs.voices[lang] = { ...prefs.voices[lang], [gender]: voice };
      chrome.storage.sync.set({ voices: prefs.voices });
    }
    changeSetting("voice", voice);
  }

  function changeSetting(key, value) {
    settings[key] = value;
    if (key === "speed") chrome.storage.sync.set({ speed: value });
    // Keep the sentence being spoken; re-synthesize everything after it.
    for (const k of [...cache.keys()]) if (k !== index) cache.delete(k);
    prefetch();
    if (key === "voice") send("warm", { voice: value }).catch(() => {});
  }

  // --- UI ------------------------------------------------------------------
  const CSS_UI = `
    :host { all: initial; }
    .bar {
      position: fixed; left: 0; right: 0; bottom: 20px; margin: 0 auto; width: max-content;
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
    .help {
      flex-basis: 100%; display: grid; grid-template-columns: auto auto; gap: 5px 14px;
      justify-content: center; padding: 6px 4px 2px; font-size: 12px;
    }
    .help dt { text-align: right; white-space: nowrap; }
    .help dd { margin: 0; opacity: .85; }
    kbd {
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,.14);
    }
    .hint {
      margin-left: 6px; padding: 1px 4px; font-size: 10px; line-height: 1.3;
      vertical-align: 1px; opacity: .7; background: rgba(255,255,255,.12);
    }
    .play .hint { background: rgba(0,0,0,.12); opacity: .8; }
    .speed { display: inline-flex; align-items: center; }
    .speed .hint { margin: 0 2px 0 5px; }
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

    const language = el("select", { title: "Language" });
    for (const [code, { label }] of Object.entries(KR.LANGUAGES)) {
      language.append(el("option", { value: code, textContent: label }));
    }
    const voice = el("select", { title: "Voice" });
    const fillVoices = () => {
      voice.replaceChildren();
      for (const [g, names] of Object.entries(KR.LANGUAGES[lang].voices)) {
        if (!names.length) continue;
        const og = el("optgroup", { label: g[0].toUpperCase() + g.slice(1) });
        for (const n of names) og.append(el("option", { value: n, textContent: KR.voiceLabel(n) }));
        voice.append(og);
      }
      voice.value = settings.voice;
    };
    language.value = lang;
    fillVoices();
    voice.onchange = () => chooseVoice(voice.value);
    language.onchange = () => {
      lang = language.value;
      chooseVoice(KR.pickVoice(prefs, lang, gender), false);
      fillVoices();
    };

    const speed = el("select", { title: "Speed (- / +)" });
    for (const s of SPEEDS) speed.append(el("option", { value: s, textContent: s + "×" }));
    speed.value = settings.speed;
    speed.onchange = () => changeSetting("speed", parseFloat(speed.value));

    // The icon sits in its own span so render() can swap it without losing the key hint.
    const hint = (key) => el("kbd", { className: "hint", textContent: key });
    const btn = (icon, title, fn, key = "", cls = "") => el("button", { title, onclick: fn, className: cls },
      key ? [el("span", { textContent: icon }), hint(key)] : [icon]);
    const play = btn("▶", "Play / pause (K)", togglePause, "K", "play");
    const followBtn = btn("⌖ Follow", "Scroll back to the voice (F)", () => { userScrolledAt = 0; follow(true); }, "F");
    followBtn.hidden = true;
    const meta = el("span", { className: "meta" });
    const statusEl = el("div", { className: "status" });

    const help = el("dl", { className: "help", hidden: true });
    for (const [keys, what] of SHORTCUTS) {
      const dt = el("dt");
      keys.forEach((k, i) => { if (i) dt.append(" "); dt.append(el("kbd", { textContent: k })); });
      help.append(dt, el("dd", { textContent: what }));
    }

    const bar = el("div", { className: "bar" }, [
      btn("⏮", "Previous sentence (← or J)", () => jump(index - 1, true), "J"),
      play,
      btn("⏭", "Next sentence (→ or L)", () => jump(index + 1, true), "L"),
      btn("↺", "Re-read sentence (R)", replay, "R"),
      el("span", { className: "speed", title: "Slower / faster (- / +)" }, [speed, hint("−+")]),
      language, voice, meta, followBtn,
      btn("⚙", "Voice and language preferences", () => send("open-options").catch(() => {})),
      btn("?", "Keyboard shortcuts (?)", toggleHelp),
      btn("✕", "Close reader (Alt+Shift+R)", close),
      statusEl, help,
    ]);
    shadow.append(bar);
    document.documentElement.append(host);
    return { host, play, meta, speed, status: statusEl, follow: followBtn, help };
  }

  const SHORTCUTS = [
    [["K"], "Play / pause"],
    [["←", "→"], "Previous / next sentence (also J / L)"],
    [["⇧←", "⇧→"], "Previous / next paragraph"],
    [["R"], "Re-read the sentence (the previous one if it just started)"],
    [["H"], "Read from here: the selection or first visible sentence"],
    [["F"], "Scroll back to the voice"],
    [["-", "+"], "Slower / faster"],
    [["⌥", "click"], "Read from the clicked sentence"],
    [["⌥⇧R"], "Close the reader"],
    [["?"], "Show / hide this list"],
  ];

  function toggleHelp() { if (ui) ui.help.hidden = !ui.help.hidden; }

  function status(text) { if (ui) ui.status.textContent = text; }

  // A short-lived notice that doesn't wipe a real status message set meanwhile.
  function flash(text, ms = 1500) {
    status(text);
    setTimeout(() => { if (ui?.status.textContent === text) status(""); }, ms);
  }

  function render() {
    if (!ui) return;
    ui.play.firstChild.textContent = paused ? "▶" : "❚❚";
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
    prefs = await KR.loadPrefs();
    const blocks = collectBlocks();
    const choice = await chooseForArticle(blocks);
    if (!active) return;   // closed while detecting
    lang = choice.lang;
    gender = choice.gender;
    settings = { voice: KR.pickVoice(prefs, lang, gender), speed: prefs.speed };
    sentences = buildSentences(blocks, lang);
    ctx = new AudioContext();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    ui = buildUI();
    addEventListener("wheel", markUserScroll, { passive: true });
    addEventListener("touchmove", markUserScroll, { passive: true });
    addEventListener("keydown", onKey, true);
    addEventListener("click", onClick, true);
    rafId = requestAnimationFrame(tick);

    if (!sentences.length) {
      render();
      return status("Couldn't find article text on this page.");
    }
    send("warm", { voice: settings.voice }).catch(() => {});
    flash([KR.LANGUAGES[lang].label, ...choice.notes].join(" · "), 5000);
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
    removeEventListener("keydown", onKey, true);
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
