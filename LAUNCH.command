#!/bin/bash
# AutoBot Trading — Launch Script
# Double-click this file in Finder to start the app

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
LAUNCHER_DIR="$PROJECT_DIR/launcher"

# Ensure Homebrew paths are available
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Check for electron in launcher
ELECTRON="$LAUNCHER_DIR/node_modules/.bin/electron"

if [ ! -f "$ELECTRON" ]; then
  osascript -e 'display alert "AutoBot Not Installed" message "Run scripts/setup.sh first to set up the app (developers), or install the packaged app from the Releases page, then try again." as critical buttons {"OK"} default button "OK"' 2>/dev/null \
    || echo "❌ Run scripts/setup.sh first (devs), or install from the Releases page."
  exit 1
fi

# Launch app (detached so Terminal window can close)
cd "$LAUNCHER_DIR"
"$ELECTRON" . &
disown

# Close the Terminal window after a short delay
sleep 1
osascript -e 'tell application "Terminal" to close (every window whose name contains "LAUNCH")' 2>/dev/null || true
