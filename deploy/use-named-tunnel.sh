#!/bin/bash
#
# Switch from the rotating quick tunnel to a named tunnel on your own hostname.
#
#   bash deploy/use-named-tunnel.sh whatmcp.example.com [tunnel-name]
#
# Run this only after `cloudflared tunnel create` and `cloudflared tunnel route
# dns` have succeeded — both need a Cloudflare account and a zone, and both are
# yours to run.
#
# Beyond swapping the tunnel, this TIGHTENS a security control. The quick tunnel
# forced the Host check down to suffix matching on `.trycloudflare.com`, because
# the hostname changed on every reconnect. A stable hostname means that
# compromise can be undone: the suffix is removed and the exact host restored.
set -euo pipefail

HOSTNAME="${1:-}"
TUNNEL="${2:-whatmcp}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"

if [ -z "$HOSTNAME" ]; then
  echo "usage: bash deploy/use-named-tunnel.sh <hostname> [tunnel-name]" >&2
  echo "   eg: bash deploy/use-named-tunnel.sh whatmcp.example.com" >&2
  exit 1
fi
if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found" >&2
  exit 1
fi
if ! "$CLOUDFLARED" tunnel list 2>/dev/null | grep -q "$TUNNEL"; then
  echo "No tunnel named '$TUNNEL'. Create it first:" >&2
  echo "  cloudflared tunnel login" >&2
  echo "  cloudflared tunnel create $TUNNEL" >&2
  echo "  cloudflared tunnel route dns $TUNNEL $HOSTNAME" >&2
  exit 1
fi

echo "hostname: $HOSTNAME"
echo "tunnel:   $TUNNEL"

# 1. Pin the OAuth issuer, and restore exact Host matching.
node --experimental-sqlite --experimental-strip-types --no-warnings -e "
  import('$REPO/src/config.ts').then(function (c) {
    c.writeFileConfig({
      public_url: 'https://$HOSTNAME',
      http_allowed_hosts: ['$HOSTNAME'],
      // Deliberately emptied: with a stable hostname there is no reason to accept
      // every name under a shared public suffix.
      http_allowed_host_suffixes: [],
    });
    console.log('config: public_url=https://$HOSTNAME, exact host allowlist restored');
  });
"

# 2. Point the tunnel agent at the named tunnel.
sed -e "s|__CLOUDFLARED__|$CLOUDFLARED|g" \
    -e "s|__HOME__|$HOME|g" \
    "$REPO/deploy/com.whatmcp.tunnel.plist" \
  | python3 -c "
import sys, re
p = sys.stdin.read()
# Replace the quick-tunnel argv with 'tunnel run <name>'.
p = re.sub(
    r'<key>ProgramArguments</key>\s*<array>.*?</array>',
    '''<key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>--url</string>
    <string>http://127.0.0.1:8787</string>
    <string>$TUNNEL</string>
  </array>''',
    p, flags=re.S)
sys.stdout.write(p)
" > "$AGENTS/com.whatmcp.tunnel.plist"

# 3. Reload both agents.
for label in com.whatmcp.tunnel com.whatmcp.server; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$label.plist"
  echo "reloaded $label"
done

echo
echo "waiting for the tunnel…"
sleep 8
echo -n "health via $HOSTNAME: "
curl -s -o /dev/null -w "%{http_code}\n" "https://$HOSTNAME/health" || echo "unreachable yet"
echo
echo "MCP endpoint:  https://$HOSTNAME/mcp"
echo "OAuth issuer:  https://$HOSTNAME"
echo "Add to ChatGPT: Settings -> Connectors -> Developer mode -> https://$HOSTNAME/mcp"
