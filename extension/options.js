// Preferences page: detection switches, defaults, and one voice per language and gender.

const $ = (id) => document.getElementById(id);
let prefs;
let savedTimer = 0;
let audio = null;

function save(patch) {
  Object.assign(prefs, patch);
  chrome.storage.sync.set(patch).then(() => {
    $("saved").classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1200);
  });
}

function option(value, text) {
  return Object.assign(document.createElement("option"), { value, textContent: text });
}

// Speak the language's sample sentence in the chosen voice.
async function preview(voice, lang) {
  const res = await chrome.runtime.sendMessage({
    type: "speak",
    body: { text: KR.LANGUAGES[lang].sample, voice, speed: 1 },
  });
  if (!res?.ok) return alert(res?.error === "offline" ? "Voice server not running." : res?.error);
  audio?.pause();
  audio = new Audio("data:audio/wav;base64," + res.data.audio);
  audio.play();
}

function voiceCell(lang, gender) {
  const td = document.createElement("td");
  const names = KR.LANGUAGES[lang].voices[gender];
  if (!names.length) return Object.assign(td, { textContent: "none", style: "opacity:.5" });
  const select = document.createElement("select");
  for (const n of names) select.append(option(n, KR.voiceLabel(n)));
  select.value = KR.pickVoice(prefs, lang, gender);
  select.onchange = () => {
    save({ voices: { ...prefs.voices, [lang]: { ...prefs.voices[lang], [gender]: select.value } } });
    preview(select.value, lang);
  };
  const play = Object.assign(document.createElement("button"), { textContent: "▶", title: "Preview" });
  play.onclick = () => preview(select.value, lang);
  td.append(select, " ", play);
  return td;
}

(async () => {
  prefs = await KR.loadPrefs();
  for (const key of ["autoLanguage", "autoGender"]) {
    $(key).checked = prefs[key];
    $(key).onchange = () => save({ [key]: $(key).checked });
  }
  for (const [code, { label }] of Object.entries(KR.LANGUAGES)) $("fallbackLanguage").append(option(code, label));
  $("fallbackLanguage").value = prefs.fallbackLanguage;
  $("fallbackLanguage").onchange = () => save({ fallbackLanguage: $("fallbackLanguage").value });
  $("fallbackGender").value = prefs.fallbackGender;
  $("fallbackGender").onchange = () => save({ fallbackGender: $("fallbackGender").value });

  for (const [code, { label }] of Object.entries(KR.LANGUAGES)) {
    const tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), { textContent: label }),
      voiceCell(code, "female"), voiceCell(code, "male"));
    $("voices").append(tr);
  }
})();
