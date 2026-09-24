#!/bin/bash
# Install the Kokoro Reader server as a login agent (launchd).
# The Chrome extension itself is loaded by hand; see README.md.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv"
LABEL="com.kokoro-reader.server"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/kokoro-reader.log"

# kokoro supports Python 3.10-3.12 only.
PY=""
for v in 3.12 3.11 3.10; do
  if command -v "python$v" >/dev/null; then PY="$(command -v "python$v")"; break; fi
done
[ -n "$PY" ] || { echo "Need Python 3.10-3.12 (brew install python@3.12)"; exit 1; }

command -v espeak-ng >/dev/null || { echo "==> Installing espeak-ng"; brew install espeak-ng; }

if [ ! -x "$VENV/bin/python" ]; then
  echo "==> Creating virtualenv with $PY"
  "$PY" -m venv "$VENV"
fi
echo "==> Installing Python dependencies"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$ROOT/server/requirements.txt"

echo "==> Installing launch agent $LABEL"
mkdir -p "$(dirname "$AGENT")" "$(dirname "$LOG")"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV/bin/python</string>
        <string>$ROOT/server/reader_server.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>PYTHONWARNINGS</key><string>ignore</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardErrorPath</key><string>$LOG</string>
    <key>StandardOutPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"

for _ in $(seq 1 20); do
  curl -sf http://127.0.0.1:51730/health >/dev/null && break
  sleep 0.5
done
curl -sf http://127.0.0.1:51730/health >/dev/null \
  && echo "==> Server running on http://127.0.0.1:51730 (log: $LOG)" \
  || { echo "Server did not start; see $LOG"; exit 1; }

cat <<NEXT

Now load the extension in Chrome:
  1. Open chrome://extensions and turn on "Developer mode" (top right).
  2. Click "Load unpacked" and choose: $ROOT/extension
  3. Pin "Kokoro Reader" in the toolbar puzzle menu.

On any article: click the icon or press Alt+Shift+R.
NEXT
