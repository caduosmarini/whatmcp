#!/bin/bash
#
# Install WhatMCP as two user LaunchAgents: the HTTP server, and a Cloudflare
# tunnel in front of it.
#
# Everything here is per-user and reversible. Nothing needs sudo, nothing is
# written outside ~/Library/LaunchAgents and ~/.whatmcp, and uninstall.sh undoes
# all of it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/.whatmcp/logs"
UID_NUM="$(id -u)"

NODE="$(command -v node || true)"
CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.whatmcp/bin/cloudflared")"

if [ -z "$NODE" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found at $CLOUDFLARED" >&2
  echo "Install it first, or run with:  CLOUDFLARED=/path/to/cloudflared $0" >&2
  exit 1
fi

# A launchd job inherits almost no environment, so an absolute node path is
# required; `node` alone resolves under your shell and nowhere else.
echo "node:        $NODE"
echo "cloudflared: $CLOUDFLARED"
echo "repo:        $REPO"

mkdir -p "$AGENTS" "$LOGS"

render() {
  sed -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__CLOUDFLARED__|$CLOUDFLARED|g" \
      "$1" > "$2"
}

render "$REPO/deploy/com.whatmcp.server.plist" "$AGENTS/com.whatmcp.server.plist"
render "$REPO/deploy/com.whatmcp.tunnel.plist" "$AGENTS/com.whatmcp.tunnel.plist"

# Accept the rotating quick-tunnel hostname. See the Host-check comment in
# http.ts for why this is a suffix and what it costs.
node --experimental-sqlite --experimental-strip-types --no-warnings \
  -e "
    import('$REPO/src/config.ts').then(function (c) {
      var f = c.readFileConfig();
      var s = f.http_allowed_host_suffixes || [];
      if (s.indexOf('.trycloudflare.com') === -1) s.push('.trycloudflare.com');
      c.writeFileConfig({ http_allowed_host_suffixes: s });
      console.log('allowed host suffixes:', s.join(', '));
    });
  "

for label in com.whatmcp.server com.whatmcp.tunnel; do
  # bootout first so re-running this script is an update, not an error.
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$label.plist"
  echo "loaded $label"
done

echo
echo "waiting for the tunnel to publish a URL…"
for _ in $(seq 1 30); do
  if grep -qoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" 2>/dev/null; then
    break
  fi
  sleep 1
done

npm --prefix "$REPO" run --silent wa -- url || true
