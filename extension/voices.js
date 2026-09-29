// Languages, voices and saved preferences, shared by the content script and
// the options page. Loaded first, so it only attaches itself to `self.KR`.

(() => {
  // Kokoro's first letter is the language, the second the gender (f/m).
  // Only languages the phonemizer handles without extra dependencies.
  const LANGUAGES = {
    en: {
      label: "English",
      sample: "Hello, this is my voice for reading your articles.",
      voices: {
        female: ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_aoede", "af_kore", "af_nova",
          "bf_emma", "bf_isabella", "bf_alice", "bf_lily"],
        male: ["am_michael", "am_adam", "am_eric", "am_liam", "am_onyx", "am_puck", "am_fenrir",
          "bm_george", "bm_fable", "bm_daniel", "bm_lewis"],
      },
    },
    pt: {
      label: "Português (BR)",
      sample: "Bom dia, esta é a minha voz para ler os seus artigos.",
      voices: { female: ["pf_dora"], male: ["pm_alex", "pm_santa"] },
    },
    es: {
      label: "Español",
      sample: "Buenos días, esta es mi voz para leer tus artículos.",
      voices: { female: ["ef_dora"], male: ["em_alex", "em_santa"] },
    },
    fr: {
      label: "Français",
      sample: "Bonjour, voici ma voix pour lire vos articles.",
      voices: { female: ["ff_siwis"], male: [] },
    },
    it: {
      label: "Italiano",
      sample: "Buongiorno, questa è la mia voce per leggere gli articoli.",
      voices: { female: ["if_sara"], male: ["im_nicola"] },
    },
  };

  const DEFAULTS = {
    autoLanguage: true,          // detect the language when an article starts
    autoGender: true,            // pick the voice gender from the author's name
    fallbackLanguage: "en",      // when detection is unsure or unsupported
    fallbackGender: "female",    // when there is no author or the name is ambiguous
    speed: 1.1,
    voices: {                    // preferred voice per language and gender
      en: { female: "af_heart", male: "am_michael" },
      pt: { female: "pf_dora", male: "pm_alex" },
      es: { female: "ef_dora", male: "em_alex" },
      fr: { female: "ff_siwis" },
      it: { female: "if_sara", male: "im_nicola" },
    },
  };

  const genderOf = (voice) => (voice[1] === "f" ? "female" : "male");
  const langOf = (voice) =>
    Object.keys(LANGUAGES).find((l) => Object.values(LANGUAGES[l].voices).some((vs) => vs.includes(voice)));

  function voiceLabel(voice) {
    const name = voice.split("_")[1];
    const region = langOf(voice) === "en" ? { a: " (US)", b: " (UK)" }[voice[0]] : "";
    return name[0].toUpperCase() + name.slice(1) + region;
  }

  // The saved voice for a language and gender; a language with no voice of that
  // gender (French has no male one) uses the other.
  function pickVoice(prefs, lang, gender) {
    const { voices } = LANGUAGES[lang];
    const g = voices[gender].length ? gender : gender === "female" ? "male" : "female";
    const saved = prefs.voices[lang]?.[g];
    return voices[g].includes(saved) ? saved : voices[g][0];
  }

  async function loadPrefs() {
    const stored = await chrome.storage.sync.get(null);
    const prefs = { ...DEFAULTS, voices: {} };
    for (const key of ["autoLanguage", "autoGender", "fallbackLanguage", "fallbackGender", "speed"]) {
      if (stored[key] !== undefined) prefs[key] = stored[key];
    }
    if (!LANGUAGES[prefs.fallbackLanguage]) prefs.fallbackLanguage = DEFAULTS.fallbackLanguage;
    for (const lang of Object.keys(LANGUAGES)) {
      prefs.voices[lang] = { ...DEFAULTS.voices[lang], ...stored.voices?.[lang] };
    }
    // Before per-language voices there was a single `voice`; keep the choice.
    const legacy = stored.voice;
    if (legacy && !stored.voices && langOf(legacy)) prefs.voices[langOf(legacy)][genderOf(legacy)] = legacy;
    return prefs;
  }

  self.KR = { LANGUAGES, DEFAULTS, genderOf, langOf, voiceLabel, pickVoice, loadPrefs };
})();
