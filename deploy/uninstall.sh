#!/bin/bash
#
# Remove both LaunchAgents. Leaves the archive, config and logs alone — this
# stops the service, it does not delete your message history.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

for label in com.whatmcp.tunnel com.whatmcp.server; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null && echo "stopped $label" || echo "$label was not running"
  rm -f "$AGENTS/$label.plist"
done

echo
echo "Removed. The archive at ~/.whatmcp/archive.db is untouched."
echo "To also close the public URL, confirm nothing is listening:  curl -sS localhost:8787/health || echo down"
