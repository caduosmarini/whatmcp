import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBatches, estimateTokens, InputTooLongError } from '../src/index/openai.ts';
import { chunk } from '../src/index/chunker.ts';
import { execFileSync } from 'node:child_process';

test('long unbroken Unicode text completes in a bounded subprocess without losing its tail', () => {
  const moduleUrl=new URL('../src/index/chunker.ts',import.meta.url).href;
  // The former JS BPE implementation stalls for minutes on long Unicode runs.
  // A child deadline also detects that regression when its event loop is blocked.
  const code=`
    import {chunk} from ${JSON.stringify(moduleUrl)};
    const text='\\u3164'.repeat(61056)+' fim';
    const windows=chunk([{message_id:'audio',thread_id:'chat',sender_name:'Ana',ts:1,text}]);
    const restored=windows.map(w=>w.text.slice('Ana: '.length)).join('');
    console.log(JSON.stringify({parts:windows.length,complete:restored.replaceAll(' ','')===text.replaceAll(' ','')}));
  `;
  const out=execFileSync(process.execPath,[
    '--experimental-sqlite','--experimental-strip-types','--no-warnings',
    '--input-type=module','-e',code,
  ],{encoding:'utf8',timeout:20000,windowsHide:true});
  const result=JSON.parse(out);
  assert.ok(result.parts>1);
  assert.equal(result.complete,true);
});

test('valid non-Latin and emoji payloads are embedded intact', () => {
  for (const text of ['例'.repeat(3000) + ' término', '😀'.repeat(3000)]) {
    const [batch] = splitBatches([text]);
    assert.equal(batch.truncated, 0);
    assert.equal(batch.texts[0], text);
  }
});
test('batches use tokens rather than bytes and respect request ceilings', () => {
  const text = 'A reunião de amanhã será sobre orçamento e manutenção. '.repeat(75);
  const input = Array(1000).fill(text);
  const batches = splitBatches(input);
  assert.ok(batches.length < 10);
  assert.deepEqual(batches.flatMap(b => b.texts), input);
  for (const b of batches) {
    assert.ok(b.texts.length <= 256);
    assert.ok(b.texts.reduce((n,t)=>n+estimateTokens(t),0)<=250000);
  }
});
test('oversized transcripts split into complete, attributable windows without broken Unicode', () => {
  const text = '﷽'.repeat(3000) + ' término';
  assert.throws(()=>splitBatches([text]),InputTooLongError);
  const windows=chunk([{message_id:'audio',thread_id:'chat',sender_name:'Ana',ts:1,text}]);
  assert.ok(windows.length>1);
  assert.ok(windows.map(w=>w.text.slice('Ana: '.length)).join('').replaceAll(' ','') === text.replaceAll(' ',''));
  for (const w of windows) {
    assert.ok(estimateTokens(w.text)<=8000);
    assert.ok(!w.text.includes('\uFFFD'));
    assert.equal(w.parts[0].message_id,'audio');
  }
  const parts=windows.flatMap(w=>w.parts.map(p=>p.part_no));
  assert.equal(new Set(parts).size,parts.length);
});
