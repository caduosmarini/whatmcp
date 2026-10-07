# Audio transcription

Transcription is disabled by default. `npm run setup` asks whether to enable it,
lists models available on the current computer, estimates the accessible backfill,
and asks separately before starting it. Setup saves one default language.
The three configured model values are
`apple-speech`, `apple-dictation` (macOS), and `gpt-transcribe` (macOS or Windows).
Set `transcription_model` to `null` to disable new transcription. The embedding
model is a separate setting.

The audio settings in `~/.whatmcp/config.json` are:

```json
{
  "transcription_model": "apple-speech",
  "transcription_auto_after_import": false,
  "transcription_default_language": "pt-BR",
  "transcription_concurrency": 2
}
```

`transcription_default_language` accepts one language tag, normalized for cache
identity (for example `pt_BR` becomes `pt-BR`). It defaults to `pt-BR`; language
lists and automatic language selection are not supported. The old
`transcription_locale` key remains a fallback when the new key is absent.
Cloud concurrency defaults to 2 and accepts integers from 1 to 4. Apple models
always process one audio at a time. Changing the default model or language affects
new audio; use `--reprocess` to replace already completed historical transcripts.

`gpt-transcribe` uploads audio to OpenAI. The Apple models run locally and may
need a language asset downloaded during setup. All published transcript text is
part of the normal conversation windows, so `npm run embed` sends that text to
the configured embedding API. A key alone never enables audio upload.

## Media files

The macOS adapter links an audio message to `ZMEDIAITEM.ZMEDIALOCALPATH` and
resolves it below WhatsApp's `Message` group-container directory. Paths that are
absolute, leave the configured root, or follow a symlink outside it are rejected.
The SQLite reference does not guarantee that the audio file is still on disk.

On Windows, the [WAren6 source](WINDOWS.md) collects locally available audio
and imports verified message references into `WHATMCP_HOME/media/windows`.
The importer checks the actual SHA-256 and size, rejects ambiguous filenames or
paths claimed by different messages, and preserves bytes independently of the
case directory. It revisits media metadata even for old archived messages below
the text watermark. Missing or rejected files leave message history intact.
Override the durable root with `media_roots.windows` if needed. Older WAren6
schemas without media metadata remain usable for text imports.

For a compatible `ChatStorage.sqlite` as described in [File import](IMPORT.md),
if the SQLite file contains `ZMEDIAITEM` paths and matching files have been
extracted, set the root explicitly:

```sh
npm run wa -- media import --root=/path/to/extracted/Message --source=import
```

For files saved separately, use a JSON manifest with unambiguous stable message
IDs. Each entry is `{ "message_id": "chat-jid:stanza-id", "relative_path": "voice.ogg" }`.
Unknown messages and unsafe paths are rejected; a filename alone does not prove
which message an audio belongs to.

```sh
npm run wa -- media import --root=/path/to/files --source=import --manifest=/path/to/manifest.json
```

## Resume and publish

```sh
npm run wa -- transcribe-models   # availability and reason on this host
npm run wa -- transcribe --limit=100
npm run wa -- doctor
npm run embed                  # estimate first; sends new text windows to OpenAI
```

`transcribe` runs independently of the five-minute message-sync watchdog. One
process holds a separate transcription lock. It saves a stable segment plan and
each completed segment, so a later run resumes an interrupted file. Long files
are split into at most ten-minute pieces, preferring nearby silence when possible.
The preceding segment provides text context for cloud transcription. Compatible
cloud files up to ten minutes and 25 MB are uploaded in their original compressed
format; other inputs are converted with `ffmpeg`. `ffprobe` inspects duration.
Neither tool is installed automatically.

Results are cached by audio SHA-256, engine, pipeline revision and language. The
same forwarded audio can reuse a completed result without another model call.
Unchanged files are not hashed on every run: size and modification time detect
ordinary replacements, with a full hash check at least daily. Use
`--verify-files` to check all accessible bytes immediately. An immutable temporary
copy is verified against the claimed hash before model processing.

Successful results are composed in timestamp and message-ID order with original
text and captions. Usable transcripts are published every 25 completed messages
and at the end of a run, switching each conversation's FTS windows in one database
transaction. A failed or unavailable audio does not prevent other transcripts
from appearing. Pending audio and failures are exposed through `doctor`, archive
status and conversation reads. If embeddings are missing, keyword search works
immediately; semantic search reports its incomplete vector coverage. `embed`
resumes by content hash. Identical words keep their embedding hash even if the
transcription engine changes.

A new default engine, language or pipeline revision preserves archived usable
transcripts. Reprocessing is explicit and resumable:

```sh
npm run wa -- transcribe --reprocess --limit=100
npm run wa -- transcribe --limit=100  # continue the queued replacement work
```

During replacement, previous usable transcripts remain visible until the new
result is ready. An empty replacement preserves already recognized words for
identical audio bytes; the empty result remains archived. Conversation reads identify an older transcript when its source
file has changed. Setting `transcription_model` to `null` pauses new processing;
it preserves published transcripts and their search windows.

Provider retries are bounded and honor `Retry-After`. A long cooldown is stored
in the archive and survives restart. Authentication, quota, language-asset and
other systemic failures stop new work instead of repeating the same failure for
every file. After fixing a persistent error, run:

```sh
npm run wa -- transcribe --retry-errors
```

Permanent errors otherwise stay recorded. The setup estimate counts pending,
uncached audio only, distinguishes unavailable and reusable files, and makes no
model request merely to estimate the work.

Set `transcription_auto_after_import` to `true` to transcribe pending accessible
audio automatically after every scheduled or manual `sync`, `index`,
`import-windows`, and `media import`. Processing runs after import and before
embeddings, under the shared import/sync lock. It uses the configured model and
language, resumes interrupted segments, and reuses completed content hashes;
it does not request historical replacement or reset permanent errors.
The option defaults to `false`; a configured transcription model alone does not
enable automatic uploads. With it disabled, sync still embeds pending text,
while manual index/import commands retain their import-only behavior.

Automatic transcription requires `transcription_model` too. On Windows:

```json
{
  "transcription_model": "gpt-transcribe",
  "transcription_auto_after_import": true,
  "transcription_default_language": "pt-BR"
}
```

Usable partial transcripts and new text are embedded even if some audio fails;
the command then reports the failure. Unavailable audio does not block imports.
The next run resumes pending work, respecting provider cooldowns. The automatic
sync watchdog allows an additional 45 minutes (75 total on Windows, 50 for
ChatStorage); a timeout preserves completed work and pauses scheduled sync until
a successful manual retry. Direct manual imports are outside that sync watchdog.
Standalone `transcribe` remains available and retains its explicit batch limit.

Windows scheduled sync uses WAren6 and preserves the
available audio; choose `gpt-transcribe` explicitly and provide `ffmpeg`/`ffprobe`
on the account's PATH (or configure their paths) before processing it. Apple
models require macOS. One default language remains `pt-BR`.

Embedding batches count `cl100k_base` tokens locally, following the
[OpenAI embedding guidance](https://developers.openai.com/api/docs/guides/embeddings).
New windows split oversized Unicode text into attributable parts before hashing;
valid payloads are sent in full. Legacy oversized windows are reported and left
pending, keeping keyword search available. Run `npm run wa -- project --rewindow`
to rebuild windows from the durable archive (including active transcripts), then
retry embeddings. This does not require the original source or call a model.

## Native integration check

The normal test suite uses synthetic SQLite/files and offline provider transports.
On a Mac with both Apple pt-BR assets already installed, `say`, `ffmpeg`, `ffprobe`
and Swift, an opt-in integration check generates speech, converts it to Opus,
transcribes through both Apple engines, verifies conversation reads and FTS, and
checks that a second run does no duplicate work:

```sh
WHATMCP_HOME="$(mktemp -d)" node --experimental-sqlite --experimental-strip-types \
  --no-warnings scripts/native-audio.smoke.ts
```

It does not use the live WhatsApp store, upload audio, or download models.
Successful synthetic recognition verifies integration, not accuracy on real voice
messages. A model can return empty text even where another model recognizes speech;
quality and the final service/Windows environment still need separate validation.
