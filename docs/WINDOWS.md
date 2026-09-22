# Windows: iPhone history plus WhatsApp Desktop increments

The iPhone backup is the historical base. Windows Desktop contributes later
messages to the **same durable archive**. Neither source is ever overwritten.
The Windows app's local databases are encrypted; pointing WhatMCP at
`genericStorage.db` does not work. WhatMCP invokes the separate
[WAren6](https://github.com/MayukXT/WAren6) GPL-3.0 tool in offline mode, then
imports its validated `unified_whatsapp.db`. No WAren6 code is bundled here.

## One-time setup

1. Install WhatsApp Desktop and sign in. Install Node 22.6+ and PowerShell.
2. Clone WAren6 separately and review its requirements:

   ```powershell
   git clone https://github.com/MayukXT/WAren6.git C:\path\to\WAren6
   ```

3. Keep the WhatMCP archive and API key outside the checkout. If using a
   nondefault location, set `WHATMCP_HOME` in the shell **and** in the MCP
   configuration. Then configure the Windows source:

   ```powershell
   npm run wa -- windows-source C:\path\to\WAren6
   ```

   This writes `source_type=windows-waren6` and `windows_waren6_path` to
   `config.json`; it does not run extraction. Optional config field
   `windows_output_dir` changes the private case directory (default:
   `WHATMCP_HOME\windows-cases`).

4. An already completed WAren6 case can be imported without running WAren6
   again:

   ```powershell
   npm run wa -- import-windows C:\path\to\unified_whatsapp.db
   npm run wa -- embed
   ```

   `import-windows` checks the SQLite schema and `quick_check`. The first pass
   imports records newer than the newest message already in the archive. Later
   passes revisit the last seven days; stable `chat_jid:msg_id` keys prevent
   duplicates. Rows without a stable message ID are counted and skipped.
   `--full` intentionally scans all available Windows records, without deleting
   the iPhone history. Embedding sends new text windows to OpenAI, as in macOS.

## Acquisition and scheduled sync

`npm run sync` with the Windows source runs WAren6 offline
(`-f -n -NoArchive`), with no media copy, Telegram transfer, or online
dependency bootstrap. It accepts only a new case whose validation report says
`ok`, imports it, then embeds new windows. Each WAren6 case contains decrypted
personal data and key material. Keep the output in a private directory, out of
Git and cloud-sync folders; do not share its logs or database.

**Current limitation:** WAren6 2.0.0 closes a running WhatsApp even in offline
mode, to release file locks. When WhatsApp is running, WhatMCP shows a Windows
Yes/No dialog before acquisition. No cancels without closing the app. After
an accepted run, WhatMCP attempts to reopen it even if extraction or import fails. A
shared lock suppresses a second sync and dialog while one is awaiting approval
or extracting; stale locks from crashed processes are recovered. This needs
an interactive Windows session. Closing WhatsApp yourself before a manual
`npm run sync` also works.

`npm run wa -- sync-every <hours>` registers a per-user Windows Task Scheduler
job; `sync-every 0` removes it. Registration is refused unless
`WHATMCP_WINDOWS_ALLOW_STOP_WHATSAPP=1` is explicitly set. This opts into
scheduled prompts, not automatic approval of closing WhatsApp. No task is
installed by setup automatically. The job uses the configured `WHATMCP_HOME`,
does not put the API key or iPhone backup password in its command line, and
avoids overlapping runs. Be aware that each run currently performs a full
WAren6 extraction and may close WhatsApp. In a 249k-message corpus, that took
about eight minutes and roughly 2.4 GB peak process memory; a short cadence is
not advisable.

## Why not copy the live database?

The Windows app stores encrypted SQLite plus WAL and WebView2 IndexedDB. A
plain file-by-file copy while it writes can mix different moments and omit
committed WAL data. A possible non-disruptive path is one VSS snapshot of the
volume, copying **only the WhatsApp files** from that instant, then running
WAren6 against the copy. VSS without a WhatsApp writer is crash-consistent,
not application-consistent. This path has **not** been implemented or validated
here; automatic no-close sync must not claim to work yet. It will also need an
incremental extractor to avoid WAren6's expensive full unification every time.

## No-close native-source options (research, not enabled)

The requirement here is to use data from the **installed WhatsApp for Windows**,
not a second WhatsApp Web/Chromium session.

- **VSS + WAren6:** make one point-in-time shadow copy of the NTFS volume and
  copy only the app's LocalState, IndexedDB, and Local Storage from it. Adapt
  WAren6 to skip its unconditional WhatsApp shutdown when given an offline
  copy. The snapshot is crash-consistent without a WhatsApp VSS writer, so
  decrypt, run SQLite integrity checks, and compare source/message coverage
  before accepting any import. This machine exposes the VSS API but the
  current shell is not administrator; no VSS test has been run.
- **Existing-app WebView2 runtime:** WAren6 has a research capture that asks
  the installed app's Store 8 for decoded rows through a DevTools endpoint.
  This is not a second browser session, but the endpoint is not currently
  enabled here. WebView2 generally needs a one-time app restart to enable
  remote debugging. WAren6 currently restarts the app for each capture and
  calls `table.all()`, so it is neither no-close nor incremental as shipped.
  A separate implementation would need a safe local endpoint, paginated
  changed-row queries, checkpoints, and tests after app updates. The endpoint
  must not be exposed beyond loopback.
- **Plain robocopy of live files:** rejected for automation because files can
  represent different moments and the DB/WAL pair can be inconsistent.

WAren6 is GPL-3.0 and WhatMCP is MIT. This repo invokes WAren6 as a separate
dependency; copying its implementation into WhatMCP would require a licensing
decision and careful attribution. No automatic no-close capture is claimed yet.
