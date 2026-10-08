/** Acquire audio only when WhatsApp supplies its identity, key and content hash. */
import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 32 * 1024 * 1024;
const suffixFor = (mime:string|null) => /ogg|opus/i.test(mime??'')?'.ogg':/mp4|m4a/i.test(mime??'')?'.m4a':/mpeg/i.test(mime??'')?'.mp3':'.audio';

export function mediaBytes(value: string): Buffer {
  const bytes = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (bytes.length !== 32) throw new Error('invalid media identity');
  return bytes;
}

export function audioUrl(directPath: string | null, supplied: string | null): string {
  const url = new URL(directPath?.startsWith('/') ? `https://mmg.whatsapp.net${directPath}` : supplied ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'mmg.whatsapp.net' || url.hostname.endsWith('.whatsapp.net')) ||
      !url.pathname.startsWith('/')) throw new Error('invalid media endpoint');
  return url.href;
}

export function decryptAudio(encrypted: Buffer, key: string, expected: string, encryptedHash: string | null): Buffer {
  if (encrypted.length <= 10 || encrypted.length > MAX_BYTES) throw new Error('invalid audio size');
  if (encryptedHash && sha(encrypted) !== mediaBytes(encryptedHash).toString('hex')) throw new Error('encrypted hash mismatch');
  const expanded = Buffer.from(hkdfSync('sha256', mediaBytes(key), Buffer.alloc(32), 'WhatsApp Audio Keys', 112));
  const iv = expanded.subarray(0,16), cipherKey = expanded.subarray(16,48), macKey = expanded.subarray(48,80);
  const ciphertext = encrypted.subarray(0,-10), mac = encrypted.subarray(-10);
  const calculated = createHmac('sha256',macKey).update(iv).update(ciphertext).digest().subarray(0,10);
  if (!timingSafeEqual(mac,calculated)) throw new Error('audio authentication failed');
  const decipher = createDecipheriv('aes-256-cbc',cipherKey,iv);
  const plain = Buffer.concat([decipher.update(ciphertext),decipher.final()]);
  if (sha(plain) !== mediaBytes(expected).toString('hex')) throw new Error('audio content hash mismatch');
  return plain;
}

async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Origin:'https://web.whatsapp.com'}});
  if (!response.ok) throw new Error(`media HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('audio too large');
  if (!response.body) throw new Error('empty media response');
  const reader=response.body.getReader(), chunks:Buffer[]=[];let size=0;
  try { for (;;) { const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>MAX_BYTES)throw new Error('audio too large');chunks.push(Buffer.from(next.value)); }
  } finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(chunks);
}

export async function acquireWindowsAudio(sourcePath: string, durableRoot: string, options: {
  fetcher?: typeof fetch; after?: number; limit?: number; budgetMs?: number;
  metadata?: {msg_id:string;chat_jid:string;media_key:string|null;media_direct_path:string|null;media_url:string|null}[];
} = {}) {
  const db = new DatabaseSync(sourcePath);
  const result={downloaded:0,reused:0,failed:0,eligible:0};
  try {
    const columns=new Set((db.prepare('PRAGMA table_info(messages)').all() as {name:string}[]).map(r=>r.name));
    if (!['media_filehash','media_enc_filehash'].every(c=>columns.has(c))) return result;
    const secrets = new Map(options.metadata?.map(r=>[`${r.chat_jid}:${r.msg_id}`,r]));
    const field = (name:string) => columns.has(name) ? name : `NULL ${name}`;
    const cached=(r:any)=> {
      try { return existsSync(join(dirname(sourcePath),'.whatmcp-plain',mediaBytes(r.media_filehash).toString('hex'))) ||
        !!r.media_enc_filehash && existsSync(join(dirname(sourcePath),'.whatmcp-encrypted',mediaBytes(r.media_enc_filehash).toString('hex'))); }
      catch { return false; }
    };
    const plainOrDurable=(r:any)=> {
      try { const hash=mediaBytes(r.media_filehash).toString('hex');return existsSync(join(dirname(sourcePath),'.whatmcp-plain',hash)) || existsSync(join(durableRoot,hash+suffixFor(r.media_mime_type))); }
      catch { return false; }
    };
    const rows=db.prepare(`SELECT rowid,msg_id,chat_jid,timestamp,media_filehash,media_enc_filehash,${field('media_key')},
      ${field('media_direct_path')},${field('media_url')},media_size,media_mime_type FROM messages WHERE msg_type IN ('audio','ptt')
      AND media_case_path IS NULL AND media_filehash IS NOT NULL AND timestamp>=?
      ORDER BY timestamp DESC,rowid DESC LIMIT ?`).all(options.after??Math.floor(Date.now()/1000)-7*86400,options.limit??200)
      .map((r:any)=>{const m=secrets.get(`${r.chat_jid}:${r.msg_id}`);return m ? {...r,media_key:m.media_key,media_direct_path:m.media_direct_path,media_url:m.media_url}:r;})
      .filter((r:any)=>plainOrDurable(r) || r.media_key && (r.media_direct_path || r.media_url || cached(r)))
      .sort((a:any,b:any)=>Number(cached(b))-Number(cached(a)) || b.timestamp-a.timestamp) as any[];
    result.eligible=rows.length;
    const update=db.prepare(`UPDATE messages SET media_case_path=?,media_sha256=?,media_filename=COALESCE(media_filename,?),media_status='local_present' WHERE rowid=?`);
    const until=Date.now()+(options.budgetMs??120000);let index=0;
    await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{
      while(index<rows.length && Date.now()<until) {
        const row=rows[index++];
        try {
          if(!row.msg_id?.trim()||!row.chat_jid?.trim())throw new Error('missing message identity');
          const hash=mediaBytes(row.media_filehash).toString('hex');
          const suffix=suffixFor(row.media_mime_type);
          const filename=hash+suffix, durable=join(durableRoot,filename);
          let bytes:Buffer;
          if(existsSync(durable) && sha(bytes=readFileSync(durable))===hash) result.reused++;
          else {
            const cached= row.media_enc_filehash ? join(dirname(sourcePath),'.whatmcp-encrypted',mediaBytes(row.media_enc_filehash).toString('hex')) : null;
            const plainCache=join(dirname(sourcePath),'.whatmcp-plain',hash);
            if(existsSync(plainCache)) { bytes=readFileSync(plainCache);if(sha(bytes)!==hash)throw new Error('cached audio hash mismatch'); }
            else bytes=decryptAudio(cached && existsSync(cached) ? readFileSync(cached) :
              await download(audioUrl(row.media_direct_path,row.media_url),options.fetcher??fetch),row.media_key,row.media_filehash,row.media_enc_filehash);
            if(row.media_size>0 && bytes.length!==row.media_size)throw new Error('audio size mismatch');
            mkdirSync(durableRoot,{recursive:true,mode:0o700});
            const temporary=durable+`.${row.rowid}.tmp`;writeFileSync(temporary,bytes,{mode:0o600});renameSync(temporary,durable);result.downloaded++;
          }
          if(row.media_size>0 && bytes.length!==row.media_size)throw new Error('audio size mismatch');
          const relative=`.whatmcp-audio/${filename}`, destination=join(dirname(sourcePath),relative);
          mkdirSync(dirname(destination),{recursive:true,mode:0o700});writeFileSync(destination,bytes,{mode:0o600});
          update.run(relative,hash,filename,row.rowid);
        } catch { result.failed++; } // URL/key never enter logs or exception output.
      }
    }));
    return result;
  } finally { db.close(); }
}
