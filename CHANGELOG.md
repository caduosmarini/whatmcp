# Changelog

Notable changes to this fork of WhatMCP are recorded here.

## [0.3.0] - 2026-10-08

### Added

- A macOS ARM64 and Windows x64 desktop app with conversation browsing, text and semantic search, audio/transcripts, processing status, manual jobs, and settings. The installers bundle Node and the backend.
- First-run choice between a synthetic demonstration and guided setup. Demo mode retains a visible setup link; the wizard chooses a new or existing archive, explains source access, saves optional provider settings, and offers an explicit first sync.
- Persisted desktop profile/setup state, synthetic UI screenshots, and a README with usage and architecture guides.
- A proposal for a future iPhone backup import wizard. Backup extraction/import through the desktop wizard is not implemented in this release; the existing manual guide remains available.

### Fixed

- Selecting an existing archive updates the selected path and conversations immediately, clears stale warnings, and invalidates requests from the previous profile. Saved profiles restore on restart and fail safely when unavailable.
- The sync-lock regression fixture now retains the SQLite owner while the worker is alive and verifies contention after forced garbage collection before checking release on termination. Both platform installer workflows pass the fixture suite.

### Upgrade notes

- Install the desktop app, then choose an existing archive to keep using `~/.whatmcp`, or explicitly create an app-owned archive. Installing the app does not move legacy data automatically. Back up an existing archive before opening it with a new version.
- The desktop uses manual sync; it does not install or replace a LaunchAgent or Windows task. `npm run setup` is not needed for the desktop setup flow. Existing CLI schedules and MCP client configuration remain independent.
- These installers have no Developer ID/notarization or Windows Authenticode signature. macOS contains ad hoc signatures for bundle integrity, which are not publisher verification. Platform prompts and user-granted FDA still apply.
- In-app updates remain disabled until a trusted updater key and signed update feed are configured. External FFmpeg/FFprobe, local Whisper/Python/model, and WAren6 dependencies are not automatically installed; Apple model downloads require an explicit action.
- Hosted fixture tests and packaged runtime checks pass; clean-machine installation, real FDA/process attribution, and live Apple/OpenAI provider behavior remain manual validation items.

## [0.2.1] - 2026-10-06

### Fixed

- Read-only archive queries no longer attempt to change database or journal file permissions. This lets MCP reads work when the process can read the archive but cannot run `chmod`, including restricted execution environments. Archive creation and writable opens still enforce owner-only permissions.

### Upgrade notes

- Restart the MCP client connection to load the fix. No archive migration, reindexing, or synchronization is required.

## [0.2.0] - 2026-10-01

### Added

- `list_messages_since` enumerates archived messages by time across chats, with an optional chat filter and a resumable cursor. It needs neither a search term nor an embedding API key. The feed has supporting database indexes and a test for messages with identical timestamps.
- Guides for importing a compatible `ChatStorage.sqlite` file on macOS or Windows and for recovering history from an encrypted iPhone backup. These are documented workflows; no new backup extractor or WhatsApp database adapter was added.

### Fixed

- Embedding continues when the API rejects an oversized input: the batch is split, successful windows are saved, and the individual rejected window remains pending for a later retry.
- Syncs launched from the CLI, schedule, MCP tool, or dashboard run in a supervised process with a five-minute limit and a short termination grace period.
- A process-held SQLite lock skips overlapping sync requests immediately, without building a queue. The lock is released if the worker is killed.
- After a sync times out, scheduled attempts pause until a manual sync succeeds. Archive status and the dashboard report the pause.

### Upgrade notes

- Run `npm install`, then `npm run index` once to create the message-feed indexes before starting the MCP server.
- If a macOS LaunchAgent was already installed, reapply its current cadence with `npm run wa -- sync-every <hours>` to install the updated scheduled command.
- The feed filters by message time. Importing older history or editing an existing message can require rescanning an earlier interval. A macOS permission prompt can still block a sync until the user grants access.
