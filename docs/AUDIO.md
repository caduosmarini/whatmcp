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

On Windows, supply a compatible `ChatStorage.sqlite` as described in
[File import](IMPORT.md). The native WhatsApp Windows database and cache are not
read automatically. If the SQLite file contains `ZMEDIAITEM` paths and matching
files have been extracted, set the root explicitly:

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

`npm run sync` continues to import messages and media references. It does not
perform transcription inside sync. This avoids blocking routine sync on a model
download, a privacy dialog, or the transcription API. To process new audio,
run `transcribe` again. Windows imports need a refreshed compatible source file
and extracted media; a scheduled Windows importer is not included.
