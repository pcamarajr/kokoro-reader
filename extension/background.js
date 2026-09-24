// Service worker: injects the reader into the active tab and proxies synthesis
// requests to the local Kokoro server. Fetching from here (extension origin,
// host permission granted) sidesteps page CORS and CSP entirely.

const SERVER = "http://127.0.0.1:51730";

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function toggle(tab) {
  if (!tab?.id) return;
  try {
    await inject(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } catch (err) {
    // chrome:// pages, the Web Store, PDFs in the built-in viewer, etc.
    console.warn("Kokoro Reader cannot run on this page:", err);
  }
}

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-reader") return toggle(tab);
  if (!tab?.id) return;
  // Other commands only matter if the reader is already on this page.
  chrome.tabs.sendMessage(tab.id, { type: command }).catch(() => {});
});

async function post(path, body) {
  const res = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "speak" || msg.type === "warm") {
    post("/" + msg.type, msg.body)
      .then((data) => reply({ ok: true, data }))
      .catch((err) =>
        reply({
          ok: false,
          error: err instanceof TypeError ? "offline" : String(err.message || err),
        })
      );
    return true; // async reply
  }
});
