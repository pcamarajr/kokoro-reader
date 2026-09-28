# Kokoro Reader

Read long articles along with a natural local voice. A Chrome extension finds
the article on the page and reads it sentence by sentence with
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), highlighting the
sentence and the word being spoken and scrolling with you. Nothing leaves your
machine.

```
extension/   Chrome MV3 extension (content.js does extraction, highlighting, playback)
server/      Local TTS server on 127.0.0.1:51730 (Python stdlib + kokoro)
scripts/     install.sh / uninstall.sh for the launchd login agent
```

## Install

```bash
./scripts/install.sh
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
choose `extension/`. Pin it from the puzzle menu.

## Use

| Action | How |
| --- | --- |
| Start / close on a page | Toolbar icon or **Alt+Shift+R** |
| Play / pause | ▶ in the bar, **K**, or **Alt+Shift+P** |
| Next / previous sentence | ⏭ ⏮, **→ / ←** (or **L / J**), or **Alt+Shift+→ / ←** |
| Next / previous paragraph | **Shift+→ / ←** |
| Re-read the sentence | ↺ or **R** (goes to the previous one if the current one just started) |
| Slower / faster | **- / +** |
| Jump to any sentence | **Alt+click** it |
| Start from a spot | Select some text first, or just scroll there; reading starts at the first visible sentence |
| Move the voice to where you scrolled | **H** (reads from the selection or the first visible sentence) |
| Back to the voice after scrolling away | **⌖ Follow** or **F** |
| List the shortcuts | **?** in the bar or on the keyboard |

Voice and speed persist. The single-key shortcuts only work while the bar is
open and you're not typing in a field; they take priority over the page's own
shortcuts. The **Alt+Shift** ones are global Chrome commands and can be changed
at `chrome://extensions/shortcuts`.
English voices get word-level highlighting; Portuguese voices get sentence-level only.

## How it works

- **Extraction**: picks the element with the most paragraph text (widening it
  when the article is split into sibling sections, and to take in the title and
  intro), collects its headings, paragraphs, list items and quotes, and skips navigation, references,
  comments, share widgets and cookie banners. Pages without `<p>` (e.g.
  paulgraham.com) are split on double `<br>`.
- **Sentences** come from `Intl.Segmenter` and are mapped to DOM `Range`s;
  highlighting uses the CSS Custom Highlight API, so the page DOM is untouched.
- **Audio**: the service worker asks the server for one sentence at a time,
  three ahead of playback (about 10× faster than real time on Apple Silicon).
  The server returns WAV plus Kokoro's per-word timestamps.
- **Server**: loads the model (~1.5 GB) on first request and exits after 30
  idle minutes; launchd restarts it without the model. It only answers requests
  with a `chrome-extension://` origin and refuses CORS preflights, so web pages
  can't use it.

## Troubleshooting

- Log: `~/Library/Logs/kokoro-reader.log`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.kokoro-reader.server`
- "Chrome needs one click": Chrome blocks audio until you interact with the
  page; press ▶ once.
- After editing the extension, hit reload on `chrome://extensions` and refresh the page.

## Requirements

macOS on Apple Silicon (Intel works, just slower), Homebrew, Python 3.10–3.12
and Google Chrome. The first run downloads the model weights (~330 MB) from
Hugging Face.

## Credits

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0), the voice model.
- [speak-kokoro](https://github.com/tatecarson/speak-kokoro) by Tate Carson, which inspired this and
  whose silence-trimming approach the server borrows.

## License

MIT
