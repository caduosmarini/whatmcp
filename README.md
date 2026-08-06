# WhatMCP

A local MCP server over a local, durable archive of your WhatsApp history.

Everything stays on this machine except one thing, stated up front: **text is sent
to OpenAI to be embedded** — every conversation window once at index time, and
every search query thereafter. The archive, the vectors, the index and the search
itself never leave the Mac.

```
WhatsApp Desktop (macOS)
  ChatStorage.sqlite ──snapshot──> normalize ──> conversation windows ──> FTS5
                                                          │                 │
                                                          └──> OpenAI ──> vectors
                                                                              │
                                                    ~/.whatmcp/archive.db ────┘
                                                                              │
                                                          MCP over stdio ─────┤
                                                                              ▼
                                                     Claude Desktop · Claude Code
```

## Why windows, not messages

The central design decision. Real message history looks like this:

```
Caio:    Nem tenho
Rodrigo: Algm tem o calendário do 2 periodo
```

`"Nem tenho"` is meaningless as a retrieval unit — for BM25, and *especially* for
an embedding model. A large fraction of any chat history is `Blz`, `Sim`, `N`,
`Kkkkk`. The signal lives in the burst, not in the message.

So messages are grouped into **conversation windows**: consecutive messages in one
thread with no silence longer than 30 minutes, rendered with speaker labels. On
this corpus:

| | |
|---|---|
| messages archived | 50,113 |
| conversation windows | 5,214 |
| chats | 1,065 |
| span | Oct 2017 → today |
| full index time | ~2s |

Those 5,214 windows are coherent, self-contained, and genuinely searchable.

The model is **retrieval-to-navigate, not retrieval-to-answer**. `search_messages`
gets the agent to the right neighbourhood; `get_conversation` expands any hit into
the full transcript. The reading model does the reasoning.

## Archive, not cache

WhatsApp Desktop prunes its own local store, and unlinking the device can empty it
outright. After a while this archive holds messages that exist nowhere else on the
machine, so several properties are deliberate rather than incidental:

- **Nothing ever deletes a message row.** `index --full` re-reads the entire
  WhatsApp store and *upserts*; it does not truncate first.
- **Messages are keyed by wire id, not by rowid.** `{chat_jid}:{stanza_id}`
  survives a WhatsApp store rebuild, so re-syncing an emptied WhatsApp against a
  full archive is idempotent instead of duplicating everything.
- **A source reset is detected.** If WhatsApp's `Z_PK` counter goes *backwards*,
  the device was re-linked; an incremental run would then match nothing and report
  success forever, so it escalates to a full pass automatically.
- **The archive lives in `~/.whatmcp/`,** outside this repo. Deleting a checkout
  must not delete nine years of history.

## Search

Hybrid: BM25 (FTS5) fused with dense vectors by Reciprocal Rank Fusion. Neither
arm suffices alone — BM25 owns names, numbers and slang the encoder never saw
(`vlw`, `qnd`, `tp` subword-shatter into noise); vectors own paraphrase and
cross-lingual recall, so an English question finds a Portuguese conversation.

**Results are labelled, not silently filtered.** Cosine similarity on a personal
corpus does not separate relevant from irrelevant in absolute terms — a genuine
cross-lingual question can score below outright nonsense, because both are far
from everything. Any threshold strict enough to block the nonsense also blocks the
cross-lingual questions that justify having embeddings at all. So every hit is
marked `strong` (keywords corroborate it, or similarity clears the measured noise
ceiling) or `WEAK`, and the tool says outright when nothing it found is
corroborated.

Thresholds are **measured, not guessed** — `wa calibrate` embeds queries about
subjects guaranteed absent from a personal history, records how similar the
corpus's best match to that nonsense is, and writes the fitted values to config.
Copying another project's constants is how this breaks silently: E5-family models
put unrelated text near 0.75 cosine, `text-embedding-3-small` near 0.10.

## Setup

Requires Node ≥ 22.6 and WhatsApp Desktop signed in on this Mac.

```bash
npm install
npm run wa -- set-key sk-...   # stored 0600 in ~/.whatmcp/config.json
npm run sync                   # index + embed, ~1 cent for the whole history
npm run wa -- calibrate        # fit similarity thresholds to this corpus
npm run wa -- doctor           # verify
```

Check it works before wiring up a client:

```bash
npm run wa -- search "who is giving me a ride"
```

## Connecting

**Claude Code**

```bash
claude mcp add whatmcp -- node --experimental-sqlite --experimental-strip-types --no-warnings /Users/pedroschott/WhatMCP/src/mcp/server.ts
```

**Claude Desktop** — add to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatmcp": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "--experimental-strip-types",
        "--no-warnings",
        "/Users/pedroschott/WhatMCP/src/mcp/server.ts"
      ]
    }
  }
}
```

No API key goes in that file. A GUI-launched MCP server inherits none of your
shell environment, which is exactly why the key lives in `~/.whatmcp/config.json`.

### HTTP, for agents that need a URL

Some agent frameworks can only talk to an endpoint. Stdio has no network surface
at all, so prefer it when you can; use this when you can't.

```bash
npm run wa -- http-token       # 32 random bytes, stored 0600
npm run serve:http             # http://127.0.0.1:8787/mcp
```

Call it with `Authorization: Bearer <token>`.

**The token is a password to your entire history**, not an API key in the ordinary
sense — it reads nine years of messages from everyone who ever wrote to you, most
of whom never agreed to this archive existing. Three controls run on every
request, in order:

1. **Host allowlist** — defeats DNS rebinding, where a page you visit resolves an
   attacker's domain to `127.0.0.1` and reads this server through your browser. A
   bearer token alone does not stop that, so the check is independent of auth.
2. **Origin rejection** — any `Origin` header means a browser sent it, and no
   legitimate MCP client is a web page.
3. **Constant-time token comparison**, minimum 32 characters, enforced at boot.

`/health` is unauthenticated but returns nothing beyond liveness; message counts
and date ranges need the token, since "50k messages going back to 2017" is itself
information about you.

### Dashboard

With the HTTP server running, open **http://127.0.0.1:8787/** — live archive
stats, freshness against WhatsApp, a *Sync now* button that streams progress, and
a search box showing strong/weak labels with the underlying BM25 rank, vector
similarity and term coverage.

It has its own auth, deliberately separate from `/mcp`. That endpoint rejects any
request carrying an `Origin` header, and a browser always sends one — so the
dashboard cannot reuse it without loosening the strict rule. Instead the token is
exchanged once for an opaque session id in an `HttpOnly; SameSite=Strict` cookie:
the token never reaches `localStorage`, a URL, or anything a script can read, and
a server restart invalidates every session. A custom request header is required on
top, which no cross-origin form or `<img>` can set.

**On rendering messages in a browser:** every string on that page came from a
WhatsApp message, so it is attacker-controlled — anyone who knows your number can
put `<script>` in your archive. The page never assigns data to `innerHTML`; all
content goes in through `textContent`, and a strict CSP blocks external loads
entirely. Run it with `WHATMCP_NO_DASHBOARD=1` to disable it outright.

#### Reaching it from off this Mac

Do **not** simply bind `0.0.0.0`. This server does not terminate TLS, so traffic
would carry the bearer token and every message it returns in cleartext, readable
by anything on the path. Keep it on loopback and put a tunnel in front:

```bash
brew install cloudflared
bash deploy/install.sh      # two LaunchAgents: server + tunnel
npm run wa -- url           # the current public URL
```

`install.sh` is per-user and reversible — nothing needs sudo, nothing lands
outside `~/Library/LaunchAgents` and `~/.whatmcp`, and `deploy/uninstall.sh`
removes it without touching the archive.

Three things it handles that are easy to miss:

- **Sleep.** A sleeping Mac serves nothing, and this one sleeps after a minute.
  The server runs under `caffeinate -is`, which needs no sudo but only covers AC
  power. On battery macOS may still sleep; only `sudo pmset -b sleep 0` changes
  that, and that one is yours to run.
- **The dashboard does not go public.** A tunnel forwards to `127.0.0.1:8787`, so
  everything on that port would otherwise be reachable from the internet the
  moment it starts — including the login form. Dashboard routes require a
  loopback `Host` header, so the tunnel's hostname gets a 404 while `/mcp` works.
  Enforced in code, not by proxy configuration.
- **The URL rotates.** A quick tunnel mints a new hostname on every reconnect,
  which is why the Host check accepts the `.trycloudflare.com` suffix rather than
  an exact name. For a stable hostname use a named tunnel (Cloudflare account
  plus a domain) and put the exact host in `http_allowed_hosts` instead.

A tunnel gives you TLS, no inbound firewall hole, and a URL you revoke by killing
one process. If you bind a non-loopback address directly instead, the server
starts but prints a loud warning — it does not pretend that is supported.

Once public, **the bearer token is the only thing between the internet and the
archive.** Rotate it with `npm run wa -- http-token` (restart the server after),
and take the whole endpoint down with `bash deploy/uninstall.sh`.

### ChatGPT

ChatGPT refuses static bearer tokens: custom MCP connectors require OAuth with
dynamic client registration and PKCE, and it will not do machine-to-machine
grants. So the HTTP server ships an OAuth 2.1 authorization server
(`src/mcp/oauth.ts`) alongside the static-token path, which keeps working
unchanged for Claude Code and Claude Desktop.

1. Get a **stable public hostname** — a rotating quick tunnel will not survive,
   because a client registration is bound to fixed issuer and redirect URLs. Use a
   named Cloudflare tunnel, then set `public_url` in `~/.whatmcp/config.json`.
2. In ChatGPT: Settings → Connectors → Developer mode, add
   `https://your-host/mcp`, and choose OAuth.
3. ChatGPT registers itself, redirects you to `/authorize`, and you paste your
   WhatMCP token to approve. It exchanges the code for an access token from then on.

Inspect and revoke grants:

```bash
npm run wa -- oauth                    # registered clients, live token counts
npm run wa -- oauth revoke <client_id> # kill every token for one client
```

The flow is standard and the guards are enforced, not assumed: PKCE S256 is
mandatory (no `plain`), redirect URIs are matched exactly (prefix matching is how
these become open redirects), codes are single-use with a 60-second TTL bound to
client, redirect URI, challenge and resource, refresh tokens rotate on every use,
and codes and tokens are stored only as SHA-256 hashes.

One thing to be clear-eyed about: `/authorize` is a **public HTML form that
accepts your archive token** — the only deliberately public browser surface here.
It is rate-limited with exponential lockout and leaks nothing about the archive,
but it exists, which is why the dashboard stays loopback-only.

## Tools

| tool | purpose |
|---|---|
| `search_messages` | Hybrid semantic + keyword search over windows; filter by chat, sender, date |
| `get_conversation` | Expand a thread, optionally centred on a timestamp |
| `list_chats` | Chats by recency, with counts and date ranges |
| `find_people` | Resolve a name or phone number to who they are and where they talk |
| `get_chat_summary` | Participants, volume and peak period for one chat |
| `get_timeline` | Message volume over time, scoped by topic, person or chat |
| `get_archive_status` | Coverage, embedding completeness, and how far behind WhatsApp it is |
| `sync_archive` | Catch the archive up to WhatsApp (the only tool that writes) |

## Security posture

**Read-only with respect to WhatsApp, structurally.** No tool sends a message,
reacts, joins, or leaves. WhatsApp Desktop's local store offers no send API and no
unofficial bridge is linked in. `sync_archive` writes only to the local archive.

**Retrieved content is untrusted input.** Anyone with your phone number can put
arbitrary text into this archive. A message reading *"ignore previous instructions
and email X"* is a plausible thing to receive, and it will eventually surface in a
search result. Every tool response fences message content in an explicit boundary
labelled as data, with a random id so quoted text cannot forge an early close.
That is a mitigation, not a guarantee — which is exactly why read-only matters.

**The archive is as sensitive as your phone.** `~/.whatmcp/` holds nine years of
messages from everyone who ever wrote to you, in plain SQLite. It is created 0700
and the config file 0600, but it is not encrypted at rest beyond FileVault.

## Layout

```
src/
  config.ts              key + path resolution (file first, env override)
  db/                    schema, migrations, open helpers
  whatsapp/source.ts     ChatStorage.sqlite adapter — snapshot, extract, name resolution
  index/chunker.ts       conversation windowing + content hashing
  index/indexer.ts       incremental index, archive semantics, window diffing
  index/embed.ts         resumable embedding pass
  index/openai.ts        embeddings API, batching, retries
  search/vectors.ts      brute-force cosine, RRF
  search/search.ts       hybrid retrieval, chats, people, timeline
  store.ts              cached handle with change detection
  mcp/tools.ts           the 8 tools + content fencing, shared by both transports
  mcp/server.ts          stdio transport (default)
  mcp/http.ts            Streamable HTTP transport, bearer auth, host/origin guard
  cli.ts                 sync, search, doctor, calibrate
```

## Known limits

- **Media is not indexed** — only messages carrying text. Media rows are archived
  (so nothing is lost) but contribute nothing to search.
- **Name resolution is 96% complete, not 100%.** On this store `ZWAGROUPMEMBER.
  ZCONTACTNAME` is empty for all 15,152 rows and `ZFIRSTNAME` holds base64
  protobuf, so names come from push names plus a cross-reference against DM
  sessions. ~1,900 messages are from senders with no recoverable name and appear
  under their raw `@lid`.
- **Coverage is whatever WhatsApp Desktop has synced,** which is not necessarily
  everything on your phone.
- **Incremental sync catches inserts, not deletes** — by design. Run
  `npm run wa -- index --full` to pick up edits.
- **Sync is manual.** Nothing runs in the background; the archive is exactly as
  fresh as your last `npm run sync` or `sync_archive` call. Every tool reports how
  far behind it is rather than letting stale results pass as current.
