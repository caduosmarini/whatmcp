/** Preserve verified audio before ephemeral WAren6 cases are pruned. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync,
  unlinkSync, writeSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveMediaPath } from '../transcription/media.ts';
import type { RawAudioReference } from '../whatsapp/source.ts';

interface Media {
  rowid: number; msg_id: string; chat_jid: string; media_filename: string;
  media_case_path: string; media_sha256: string; media_size: number | null;
}

function digest(path: string, output?: number): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
      if (output !== undefined) {
        let written = 0;
        while (written < n) written += writeSync(output, buffer, written, n - written);
      }
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function collectWindowsAudio(src: DatabaseSync, sourcePath: string, root: string,
  progress?: (s: string) => void, allowedMessages?: Set<string>): { refs: RawAudioReference[]; rejected: number } {
  const columns = new Set((src.prepare('PRAGMA table_info(messages)').all() as {name:string}[]).map(r => r.name));
  if (!['msg_type','media_filename','media_case_path','media_sha256'].every(c => columns.has(c))) {
    return { refs: [], rejected: 0 }; // older text-only WAren6 output
  }
  const rows = src.prepare(`SELECT rowid,msg_id,chat_jid,media_filename,media_case_path,media_sha256,
    ${columns.has('media_size') ? 'media_size' : 'NULL media_size'} FROM messages
    WHERE msg_type IN ('ptt','audio') AND media_case_path IS NOT NULL`).all() as unknown as Media[];
  // WAren6 currently joins local assets by filename. Refuse any filename/path
  // claimed by distinct message identities, even if the extractor linked it.
  const owners = new Map<string, Set<string>>();
  for (const r of src.prepare(`SELECT msg_id,chat_jid,media_filename,media_case_path FROM messages`).all() as unknown as Media[]) {
    for (const key of [r.media_filename && `name:${r.media_filename.toLowerCase()}`,
      r.media_case_path && `path:${r.media_case_path.replaceAll('\\', '/')}`].filter(Boolean) as string[]) {
      const set = owners.get(key) ?? new Set<string>();
      set.add(`${r.chat_jid}:${r.msg_id}`); owners.set(key, set);
    }
  }
  const refs: RawAudioReference[] = [];
  let rejected = 0;
  for (const row of rows) {
    if (allowedMessages && !allowedMessages.has(`${row.chat_jid?.trim()}:${row.msg_id?.trim()}`)) continue;
    let temporary: string | undefined;
    try {
      if (!row.msg_id?.trim() || !row.chat_jid?.trim() || !row.media_filename?.trim() ||
          !/^[a-f0-9]{64}$/i.test(row.media_sha256 ?? '')) throw new Error('incomplete audio identity');
      if ((owners.get(`name:${row.media_filename.toLowerCase()}`)?.size ?? 0) !== 1 ||
          (owners.get(`path:${row.media_case_path.replaceAll('\\', '/')}`)?.size ?? 0) !== 1) {
        throw new Error('ambiguous audio attribution');
      }
      const source = resolveMediaPath(dirname(sourcePath), row.media_case_path.replaceAll('\\', '/'));
      const before = statSync(source);
      if (row.media_size != null && row.media_size > 0 && row.media_size !== before.size) throw new Error('audio size mismatch');
      const sha = digest(source);
      if (sha !== row.media_sha256.toLowerCase()) throw new Error('audio hash mismatch');
      const extension = extname(row.media_filename).toLowerCase();
      const suffix = ['.ogg','.opus','.mp3','.wav','.m4a','.mp4','.aac','.amr','.flac','.webm'].includes(extension) ? extension : '.audio';
      const relative_path = `${sha}${suffix}`;
      mkdirSync(root, {recursive:true, mode:0o700});
      const destination = join(root, relative_path);
      if (!existsSync(destination) || digest(resolveMediaPath(root, relative_path)) !== sha) {
        temporary = join(root, `.audio-${randomUUID()}.tmp`);
        const fd = openSync(temporary, 'wx', 0o600);
        let copied: string;
        try { copied = digest(source, fd); } finally { closeSync(fd); }
        if (copied !== sha) throw new Error('audio changed during copy');
        renameSync(temporary, destination); temporary = undefined;
      }
      const after = statSync(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('audio changed during import');
      refs.push({message_id:`${row.chat_jid.trim()}:${row.msg_id.trim()}`,
        thread_id:row.chat_jid.trim(), source_pk:row.rowid, relative_path});
    } catch (error) {
      rejected++;
      progress?.(`Audio reference skipped: ${(error as Error).message}`);
    } finally { if (temporary) { try {unlinkSync(temporary);} catch { /* already removed */ } } }
  }
  return {refs, rejected};
}
