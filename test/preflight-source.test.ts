import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfiguredPreflight } from '../src/preflight.ts';
test('Windows preflight validates WAren6 and copied evidence sources instead of ChatStorage',()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-preflight-'));
  try {
    writeFileSync(join(dir,'waren6.ps1'),'# synthetic extractor');
    for(const sub of ['LocalState','LocalCache/EBWebView/Default/IndexedDB','LocalCache/EBWebView/Default/Local Storage'])
      mkdirSync(join(dir,sub),{recursive:true});
    const cfg={sourceType:'windows-waren6',windowsWaren6Path:dir,windowsSourcePath:dir,chatstorage:'absent.sqlite'} as any;
    assert.ok(runConfiguredPreflight(cfg,'win32').every(c=>c.ok));
    assert.equal(runConfiguredPreflight(cfg,'darwin').find(c=>c.label==='WAren6 source')?.ok,false);
    rmSync(join(dir,'waren6.ps1'));
    assert.equal(runConfiguredPreflight(cfg,'win32').find(c=>c.label==='WAren6 extractor')?.ok,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
