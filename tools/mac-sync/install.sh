#!/bin/bash
# Installs the Offline Reader → Obsidian sync job on this Mac.
#   curl -fsSL https://rayman239.github.io/offline-reader/tools/mac-sync/install.sh | bash
# Re-running it is safe (it updates the script). To remove: install.sh --uninstall
set -euo pipefail

OWNER="${OWNER:-rayman239}"
VAULT="${VAULT:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Offline Reader}"
BASE="$HOME/.offline-reader"
LABEL="com.offlinereader.vaultsync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC="${SRC:-https://$OWNER.github.io/offline-reader/tools/mac-sync/vault_sync.py}"
FEED_SRC="${FEED_SRC:-${SRC%/*}/feed_relay.py}"
FEED_LABEL="com.offlinereader.feedrelay"
FEED_PLIST="$HOME/Library/LaunchAgents/$FEED_LABEL.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$FEED_LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$FEED_PLIST"
  echo "Sync jobs removed. Your vault and $BASE were left in place."
  exit 0
fi

mkdir -p "$BASE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
if [[ -f "$SRC" ]]; then cp "$SRC" "$BASE/vault_sync.py"; else curl -fsSL "$SRC" -o "$BASE/vault_sync.py"; fi
chmod 755 "$BASE/vault_sync.py"
if [[ -f "$FEED_SRC" ]]; then cp "$FEED_SRC" "$BASE/feed_relay.py"; else curl -fsSL "$FEED_SRC" -o "$BASE/feed_relay.py"; fi
chmod 755 "$BASE/feed_relay.py"
/usr/bin/python3 -c 'import json,sys; json.dump({"owner": sys.argv[1], "vault": sys.argv[2]}, open(sys.argv[3], "w"), indent=2)' "$OWNER" "$VAULT" "$BASE/config.json"

# Git needs credentials: use the GitHub CLI login if present, otherwise ask for a token.
if [[ ! -f "$BASE/token" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "Paste a GitHub token with access to $OWNER/offline-reader-vault (Contents: read and write):"
  read -rs TOKEN < /dev/tty
  printf '%s' "$TOKEN" > "$BASE/token"
  chmod 600 "$BASE/token"
fi

GH_DIR="$(dirname "$(command -v gh 2>/dev/null || echo /usr/local/bin/gh)")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$BASE/vault_sync.py</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$GH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/OfflineReader-sync.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/OfflineReader-sync.out.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
# Newsletter feeds from substack.com (which blocks GitHub), every 30 minutes.
cat > "$FEED_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$FEED_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$BASE/feed_relay.py</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$GH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/OfflineReader-feeds.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/OfflineReader-feeds.out.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$FEED_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$FEED_PLIST"

echo "Installed. The vault is at:"
echo "  $VAULT"
echo "It syncs every 5 minutes. Log: ~/Library/Logs/OfflineReader-sync.log"
echo "Substack newsletters for the Feed are fetched every 30 minutes. Log: ~/Library/Logs/OfflineReader-feeds.log"
