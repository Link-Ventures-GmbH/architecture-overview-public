#!/bin/bash
# Runs Architecture Overview as a macOS background service (launchd): starts at login,
# comes back after a crash. Usage:
#   tools/install-service.sh <project folder> [port]     install or update
#   tools/install-service.sh --remove                    stop and remove
set -euo pipefail

LABEL="eu.linkventures.architecture-overview"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/architecture-overview.log"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

[ -n "${1:-}" ] || { echo "usage: tools/install-service.sh <project folder> [port] | --remove" >&2; exit 2; }
PROJECT="$(cd "$1" && pwd)"
PORT="${2:-8360}"
NODE="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/bin/cli.js</string>
    <string>$PROJECT</string>
    <string>--no-open</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$(dirname "$PROJECT")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "running $LABEL: $PROJECT on http://localhost:$PORT (log: $LOG)"
echo "if another copy still holds port $PORT, the service takes over as soon as it is free"
