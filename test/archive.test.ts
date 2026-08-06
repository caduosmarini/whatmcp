/**
 * Archive semantics — the properties that make this a backup rather than a cache.
 *
 * These tests build a miniature ChatStorage.sqlite with the same shape WhatsApp
 * uses, so the adapter, the indexer and the windowing all run for real against it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndex } from '../src/index/indexer.ts';
import { APPLE_EPOCH_OFFSET } from '../src/whatsapp/source.ts';

const APPLE = (unix: number) => unix - APPLE_EPOCH_OFFSET;

interface FakeMsg {
  pk: number;
  stanza: string;
  session: number;
  ts: number;
  text: string | null;
  fromMe?: number;
  member?: number | null;
}

function makeSource(
  dir: string,
  msgs: FakeMsg[],
  sessions: { pk: number; jid: string; name: string }[],
  members: { pk: number; jid: string }[] = [],
  pushNames: { jid: string; name: string }[] = [],
): string {
  const path = join(dir, `src-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
    CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
    CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT);
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY, ZSTANZAID TEXT, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER,
      ZTEXT TEXT, ZMESSAGEDATE REAL, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER,
      ZPARENTMESSAGE INTEGER
    );
  `);
  for (const s of sessions) {
    db.prepare('INSERT INTO ZWACHATSESSION VALUES (?,?,?)').run(s.pk, s.jid, s.name);
  }
  for (const m of members) {
    db.prepare('INSERT INTO ZWAGROUPMEMBER VALUES (?,?,?)').run(m.pk, m.jid, null);
  }
  for (const p of pushNames) {
    db.prepare('INSERT INTO ZWAPROFILEPUSHNAME VALUES (?,?)').run(p.jid, p.name);
  }
  for (const m of msgs) {
    db.prepare('INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?,?,?,?)').run(
      m.pk, m.stanza, m.fromMe ?? 0, 0, m.text, APPLE(m.ts), m.session,
      m.member ?? null, null,
    );
  }
  db.close();
  return path;
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSIONS = [{ pk: 1, jid: '5531999@s.whatsapp.net', name: 'Ana' }];

test('indexes messages and builds windows', () => {
  withTmp((dir) => {
    const src = makeSource(dir, [
      { pk: 1, stanza: 'a1', session: 1, ts: 1_700_000_000, text: 'oi' },
      { pk: 2, stanza: 'a2', session: 1, ts: 1_700_000_060, text: 'tudo bem?' },
    ], SESSIONS);

    const store = join(dir, 'archive.db');
    const r = runIndex(store, { chatstorage: '', snapshotPath: src });

    assert.equal(r.newMessages, 2);
    assert.equal(r.totalMessages, 2);
    assert.equal(r.windowsBuilt, 1, 'two messages a minute apart are one window');
    assert.equal(r.watermark, 2);
  });
});

test('re-running changes nothing', () => {
  withTmp((dir) => {
    const src = makeSource(dir, [
      { pk: 1, stanza: 'a1', session: 1, ts: 1_700_000_000, text: 'oi' },
    ], SESSIONS);
    const store = join(dir, 'archive.db');

    runIndex(store, { chatstorage: '', snapshotPath: src });
    const second = runIndex(store, { chatstorage: '', snapshotPath: src });

    assert.equal(second.newMessages, 0);
    assert.equal(second.windowsBuilt, 0, 'no window churn on a no-op sync');
    assert.equal(second.windowsDropped, 0);
  });
});

/*
 * The property that makes this an archive. WhatsApp prunes its own store, so a
 * message present at capture time and gone from the source later must survive.
 */
test('a message deleted from WhatsApp stays in the archive', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const full = makeSource(dir, [
      { pk: 1, stanza: 'a1', session: 1, ts: 1_700_000_000, text: 'keep me' },
      { pk: 2, stanza: 'a2', session: 1, ts: 1_700_000_060, text: 'me too' },
    ], SESSIONS);
    runIndex(store, { chatstorage: '', snapshotPath: full });

    // WhatsApp now shows only one of the two.
    const pruned = makeSource(dir, [
      { pk: 1, stanza: 'a1', session: 1, ts: 1_700_000_000, text: 'keep me' },
    ], SESSIONS);
    const r = runIndex(store, { chatstorage: '', snapshotPath: pruned, full: true });

    assert.equal(r.totalMessages, 2, 'the pruned message must still be archived');
  });
});

/*
 * Unlink the device and WhatsApp rebuilds its store from scratch, restarting Z_PK
 * at 1. An incremental run would then ask for `Z_PK > 2` against a store whose max
 * is 1, extract nothing, and report success forever — the archive would freeze
 * while looking perfectly healthy.
 */
test('a source reset is detected and forces a full pass', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const before = makeSource(dir, [
      { pk: 900, stanza: 'old1', session: 1, ts: 1_700_000_000, text: 'ancient' },
      { pk: 901, stanza: 'old2', session: 1, ts: 1_700_000_060, text: 'history' },
    ], SESSIONS);
    runIndex(store, { chatstorage: '', snapshotPath: before });

    // Re-linked device: fresh store, low primary keys, one brand new message.
    const after = makeSource(dir, [
      { pk: 1, stanza: 'new1', session: 1, ts: 1_700_100_000, text: 'after relink' },
    ], SESSIONS);
    const r = runIndex(store, { chatstorage: '', snapshotPath: after });

    assert.equal(r.sourceReset, true);
    assert.equal(r.fullPass, true, 'reset must escalate to a full pass');
    assert.equal(r.newMessages, 1);
    assert.equal(r.totalMessages, 3, 'pre-reset history must be preserved');
  });
});

test('stanza ids keep re-import idempotent across a source rebuild', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const first = makeSource(dir, [
      { pk: 10, stanza: 'stable', session: 1, ts: 1_700_000_000, text: 'hello' },
    ], SESSIONS);
    runIndex(store, { chatstorage: '', snapshotPath: first });

    // Same message, entirely different local primary key.
    const rebuilt = makeSource(dir, [
      { pk: 3, stanza: 'stable', session: 1, ts: 1_700_000_000, text: 'hello' },
    ], SESSIONS);
    const r = runIndex(store, { chatstorage: '', snapshotPath: rebuilt });

    assert.equal(r.totalMessages, 1, 'must not duplicate the same wire message');
  });
});

test('an edited message updates in place and rewindows its thread', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const before = makeSource(dir, [
      { pk: 1, stanza: 'e1', session: 1, ts: 1_700_000_000, text: 'orignal typo' },
    ], SESSIONS);
    runIndex(store, { chatstorage: '', snapshotPath: before });

    const after = makeSource(dir, [
      { pk: 1, stanza: 'e1', session: 1, ts: 1_700_000_000, text: 'original, fixed' },
    ], SESSIONS);
    const r = runIndex(store, { chatstorage: '', snapshotPath: after, full: true });

    assert.equal(r.updatedMessages, 1);
    assert.equal(r.windowsBuilt, 1, 'the changed text must produce a new window');
    assert.equal(r.windowsDropped, 1, 'and retire the stale one');
    assert.equal(r.totalMessages, 1);
  });
});

test('status broadcasts are not indexed as conversations', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const src = makeSource(dir, [
      { pk: 1, stanza: 's1', session: 1, ts: 1_700_000_000, text: 'real message' },
      { pk: 2, stanza: 's2', session: 2, ts: 1_700_000_010, text: 'a status post' },
    ], [
      ...SESSIONS,
      { pk: 2, jid: 'status@broadcast', name: 'Status' },
    ]);
    const r = runIndex(store, { chatstorage: '', snapshotPath: src });
    assert.equal(r.totalMessages, 1);
  });
});

test('group sender names resolve through push names', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const src = makeSource(
      dir,
      [{ pk: 1, stanza: 'g1', session: 1, ts: 1_700_000_000, text: 'oi pessoal', member: 5 }],
      [{ pk: 1, jid: '123@g.us', name: 'Turma' }],
      [{ pk: 5, jid: '999@lid' }],
      [{ jid: '999@lid', name: 'Bernardo' }],
    );
    runIndex(store, { chatstorage: '', snapshotPath: src });

    const db = new DatabaseSync(store, { readOnly: true });
    const w = db.prepare('SELECT text, speakers FROM windows').get() as any;
    db.close();
    assert.match(w.text, /^Bernardo: oi pessoal$/);
    assert.equal(w.speakers, 'Bernardo');
  });
});

/*
 * A saved contact name must beat a self-declared push name. This is the join that
 * recovers hundreds of otherwise-anonymous group senders on a real store.
 */
test('a saved contact name outranks a push name for the same identity', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const src = makeSource(
      dir,
      [{ pk: 1, stanza: 'g1', session: 1, ts: 1_700_000_000, text: 'oi', member: 5 }],
      [
        { pk: 1, jid: '123@g.us', name: 'Turma' },
        { pk: 2, jid: '999@lid', name: 'Bernardo Alvim' }, // DM: saved contact name
      ],
      [{ pk: 5, jid: '999@lid' }],
      [{ jid: '999@lid', name: 'bern' }],                  // self-declared push name
    );
    runIndex(store, { chatstorage: '', snapshotPath: src });

    const db = new DatabaseSync(store, { readOnly: true });
    const s = db.prepare('SELECT display_name FROM senders WHERE id = ?').get('999@lid') as any;
    db.close();
    assert.equal(s.display_name, 'Bernardo Alvim');
  });
});

test('media messages are archived but contribute no window text', () => {
  withTmp((dir) => {
    const store = join(dir, 'archive.db');
    const src = makeSource(dir, [
      { pk: 1, stanza: 'm1', session: 1, ts: 1_700_000_000, text: null },
      { pk: 2, stanza: 'm2', session: 1, ts: 1_700_000_010, text: 'with words' },
    ], SESSIONS);
    const r = runIndex(store, { chatstorage: '', snapshotPath: src });

    assert.equal(r.totalMessages, 2, 'the media row is still archived');
    const db = new DatabaseSync(store, { readOnly: true });
    const w = db.prepare('SELECT text FROM windows').get() as any;
    db.close();
    assert.equal(w.text, 'Ana: with words');
  });
});
