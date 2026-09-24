#!/bin/bash
# Remove the Kokoro Reader launch agent. Leaves .venv, the model cache
# (~/.cache/huggingface) and the Chrome extension in place.
LABEL="com.kokoro-reader.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Server agent removed. Remove the extension from chrome://extensions."
