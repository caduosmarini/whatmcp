# Proposal: import WhatsApp history from an iPhone backup

Status: proposed, not implemented. Updated: 2026-10-08.

## Goal

Let a person import older WhatsApp conversations from a completed local iPhone
backup through the desktop app, without terminal commands, Python installation,
or manual database extraction. The same flow should work on macOS and Windows.
It should add the history actually present in the backup to a WhatMCP archive
and leave the device backup and live WhatsApp source unchanged.

Today, [the iPhone guide](../IPHONE.md) describes a manual extraction/import
workflow. The current desktop setup wizard does **not** decrypt or import iPhone
backups. This proposal extends that wizard in a later release.

## Entry points and supported sources

During first-run setup, add **Import an iPhone backup** beside the existing
desktop source choice. For an existing archive, add **Import older history** in
Settings, with the import job and its result visible in Activity. Both entry
points open the same resumable flow; leaving it does not mark initial setup as
complete until an archive is ready.

The first complete version targets completed local backups made with Finder on
macOS or Apple Devices/iTunes on Windows. Support encrypted backups with the
user's password and unencrypted backups through separate adapters. A prepared,
compatible `ChatStorage.sqlite` remains an alternative for users who have
already extracted their data. Unsupported formats produce a clear explanation
and a link to the manual guide, rather than a partial import.

This is not an iCloud backup downloader, a WhatsApp iCloud backup decryptor, or a
tool for creating a backup directly from a connected phone. The app cannot
recover messages or media missing from the selected backup.

## Proposed wizard

| Step | What the person sees | What happens locally |
| --- | --- | --- |
| 1. Choose backup | Instructions for making and locating a backup, **Choose folder**, and a list of backups inside the selected folder with device, date, and encryption status. | Read bounded metadata in the explicitly selected folder. Verify completion and required manifest files; reject a backup still being written. |
| 2. Unlock | A password field only for an encrypted backup, **Unlock**, and an explanation that the password stays on this computer and is not saved. | Start a private extraction worker, unlock the manifest, and check whether WhatsApp files are present. Wrong passwords allow retry or cancellation. |
| 3. Review history | Available date range, conversation/message counts, media availability, compatibility results, and required disk space. | Extract only the WhatsApp database and required sidecars into private staging, create a consistent standalone copy, and validate integrity and schema. Counts describe this backup, not all history on the phone. |
| 4. Choose archive | **Create a new archive** or **Add to my current archive**, destination path, and an explanation of duplicates and conflict handling. | Preview matching against the destination. Create a recoverable destination snapshot before an existing archive is changed, acquire its writer lock, and require explicit confirmation to import. |
| 5. Import | Separate preparation and import progress, useful counts, **Cancel**, and actionable errors. | Import in checkpointed transactions with a job receipt. Keep readers usable where possible; refuse overlapping archive writers. Cancellation preserves committed progress and permits a safe retry. |
| 6. Finish | New, already present, updated, and unresolved message/media counts; **Open conversations**; optional **Prepare semantic search** and **Transcribe audio**. | Make imported text browsable immediately. Queue embeddings or transcription only after a separate explicit choice, using the existing provider configuration. |

The empty and error states are part of the flow: incomplete backup, incorrect
password, missing WhatsApp data, unreadable folder, unsupported schema, corruption,
insufficient space, and a busy archive each get a specific recovery action.
An import continues as a supervised job when navigating within the app. If the
app exits, record an interrupted state; on reopening, offer resume or discard
staging instead of silently restarting. An encrypted backup may need its
password again after restart.

The UI should show readable device/date labels and progress, rather than manifest
SQL or internal paths. Detailed, redacted diagnostics belong in an expandable
support panel. Imported history appears in the existing conversation and search
screens; a second browser UI is unnecessary.

## Architecture and data guarantees

Use the current React/Tauri shell, desktop job model, archive reader/importer,
text index, and Activity screen. Add an import coordinator with explicit states:
`selected → unlocked → validated → confirmed → importing → completed`, plus
`cancelled`, `interrupted`, and `failed`. Before confirmation, work stays in
staging and does not change the destination archive.

The coordinator should have small source adapters for an encrypted local backup,
an unencrypted local backup, and a prepared ChatStorage database. Each returns a
validated standalone source and a coverage summary. Extraction belongs in a
supervised helper with private IPC, bounded resources, cancellation, and a
long-running-job policy suitable for large backups; do not inherit the live
capture's five-minute timeout without measuring extraction costs.

The existing manual guide uses
[`iphone_backup_decrypt`](https://github.com/jsharkey13/iphone_backup_decrypt),
which is a candidate for the encrypted-backup adapter, not a chosen production
dependency. Evaluate its supported formats, maintenance, license, dependency
licenses, memory use, and packaging on both platforms before selecting it.
The shipped helper must be pinned and bundled with all required runtime pieces;
end users should not install Python or run `pip`. The unencrypted adapter needs
its own manifest/file mapping and tests; do not route it through the encrypted
adapter by assumption.

Required guarantees:

- **Read the original backup without modifying it.** Access only the user-selected
  directory. Limit extraction to the WhatsApp domain and allowlisted database
  files; validate manifest IDs, paths, file types, sizes, and symlinks. Reject
  traversal or outputs outside staging. Do not extract contacts, photos, password
  stores, or other applications' databases from the device backup.
- **Include SQLite sidecars.** Locate `ChatStorage.sqlite` in
  `AppDomainGroup-group.net.whatsapp.WhatsApp.shared` and include any matching
  `-wal`, `-shm`, and rollback journal. Resolve them on the private working copy
  using SQLite, then create a standalone snapshot with its backup API. Do not
  delete journals or use `immutable=1` to bypass a nonempty journal. Run integrity
  and supported-table/column checks before interpreting messages. See the
  [SQLite WAL rules](https://www.sqlite.org/wal.html) and
  [backup API](https://www.sqlite.org/backup.html).
- **Protect staging and secrets.** Use app-owned job directories with owner-only
  permissions on macOS and equivalent restricted ACLs on Windows. Pass the backup
  password through private IPC, never command arguments, environment variables,
  logs, configuration, Keychain, or analytics. Release it when the worker ends;
  do not claim guaranteed erasure of every managed-runtime memory copy. Persist
  only the minimum redacted state required for resume. Clean decrypted staging
  after success/discard, and offer cleanup for interrupted imports. The final
  archive is sensitive local data and is not encrypted merely because its source
  backup was encrypted.
- **Keep live sync independent.** Record backup identity and import checkpoints
  separately from the live source cursor. Importing old history must not replace
  the configured desktop source, advance its watermark, start a scheduler, install
  a LaunchAgent/task, or rewrite MCP client configuration. This requires importer
  work: the manual workflow currently uses a one-command source override and a
  follow-up live-source full pass.
- **Define message matching before reuse.** Current upserts use message identity;
  identity differences across sources can create duplicates, and equal IDs can
  update fields. Add source provenance and validate cross-source identity with
  fixtures before applying that policy to backup imports. Show proposed updates,
  preserve conflicts for review, and never resolve uncertain matches by silently
  overwriting live records. Stable backup identity plus persisted checkpoints
  must make retries idempotent.
- **Make archive recovery explicit.** Use SQLite's backup mechanism for an existing
  destination while holding a compatible writer lock. Record snapshot location,
  job identity, and committed batches before changing data. Offer recovery of
  that snapshot as an explicit action; never replace an archive that received
  later changes without warning. New archives can be prepared privately and
  activated only after validation. Multi-file media work is not covered by one
  SQLite transaction.

The first version can import messages without attachments. Show missing media
honestly and retain message metadata. A later stage may copy only referenced
WhatsApp audio present in the backup, with validated paths and a separate media
receipt; never scan or extract the entire device backup to find it.

## Permissions and optional processing

On macOS, folder selection and Full Disk Access are separate concepts. Selecting
a folder does not guarantee access to every protected location. If the OS denies
access, explain the failure and offer a user-prepared copy or platform guidance;
the app cannot grant, temporarily enable, or automatically revoke FDA. Importing
an already accessible backup must not require the live WhatsApp collector to run.
Windows should likewise report file/ACL failures without requesting elevation
for ordinary imports.

Unlocking and importing remain local. Semantic indexing sends conversation text
to the configured embedding provider; cloud transcription sends audio. Make
those choices separate from **Import**, display available cost estimates and
what leaves the computer, and allow the person to postpone either job. Local
transcription remains an option when its dependencies are already available.
No provider calls, model downloads, or schedule changes happen merely from
selecting or reviewing a backup.

## Delivery and acceptance criteria

1. **Import foundation:** implement the coordinator, receipts, destination
   snapshot, source-specific checkpoints, identity policy, and prepared-database
   path in the UI using synthetic fixtures.
2. **Local backup support:** ship the evaluated helper and both manifest adapters;
   complete folder selection, unlock, preview, and extraction on macOS/Windows.
   Release the advertised backup wizard only after these adapters and packaging
   pass validation.
3. **Media and polish:** add bounded attachment import, optional processing,
   interruption recovery, and large-backup performance improvements.

Automated fixtures should cover completed/in-progress backups, encrypted and
unencrypted manifests, wrong passwords, no WhatsApp database, unsupported schemas,
corruption, committed messages present only in WAL, hot journals, missing media,
malicious paths, disk-full errors, competing writers, cancellation, crash/resume,
cross-source ID conflicts, repeated imports, and unchanged live source cursors.
Assert that no secret appears in logs/receipts and no file outside the selected
source and app-owned destination/staging is read or written by the job.

Packaged macOS and Windows tests must run with disposable homes and backups, with
no global runtime installation. Before release, validate supported real backup
formats in disposable environments with explicit consent and privately retained
test data. Confirm that browsing/text search work without API credentials, and
that optional embedding/transcription do not start without the chosen action.

Open decisions are the extraction library/runtime, supported iOS/WhatsApp schema
matrix, cross-source conflict policy, staging quotas and retention, and whether
audio import belongs in the first shipped version. The default archive location
remains app-owned storage; choosing an existing `~/.whatmcp` archive remains an
explicit user choice.

## Primary references

- [Apple: locate and manage local backups](https://support.apple.com/en-us/108809)
  explains Finder/Apple Devices backup navigation on macOS and Windows.
- [Apple: encrypted local backups](https://support.apple.com/en-us/108353)
  explains the backup password. Resetting it does not unlock previous backups;
  the wizard must direct a user without that password to create a new usable
  backup, rather than promise recovery of the old one.
- [Existing manual workflow](../IPHONE.md) documents the extraction domain,
  sidecars, standalone snapshot, and current import limitations.

Apple documents backup creation and management; it does not publish the WhatsApp
database schema. Domain/schema support is a project compatibility responsibility
and must be validated against the declared fixture and backup matrix.
