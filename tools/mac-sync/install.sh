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

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Sync job removed. Your vault and $BASE were left in place."
  exit 0
fi

mkdir -p "$BASE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
if [[ -f "$SRC" ]]; then cp "$SRC" "$BASE/vault_sync.py"; else curl -fsSL "$SRC" -o "$BASE/vault_sync.py"; fi
chmod 755 "$BASE/vault_sync.py"
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
echo "Installed. The vault is at:"
echo "  $VAULT"
echo "It syncs every 5 minutes. Log: ~/Library/Logs/OfflineReader-sync.log"
