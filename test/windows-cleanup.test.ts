import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKER,pruneWindowsCases } from '../scripts/prune-windows-cases.ts';
test('case cleanup is bounded, preserves the last success and never deletes unowned directories',()=>{
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-cases-'));
  try {
    const root=join(dir,'cases');mkdirSync(root);
    for(let i=1;i<=5;i++) {
      const name=`20261007-10000${i}-1`, path=join(root,name);mkdirSync(path);
      writeFileSync(join(path,MARKER),JSON.stringify({schema:'whatmcp.hotcopy.v1',run_id:name,status:i===2?'ok':'failed'}));
      writeFileSync(join(path,'private.db'),'synthetic');
    }
    const unowned=join(root,'20261007-100000-1');mkdirSync(unowned);
    const backup=join(root,'user-backup');mkdirSync(backup);
    const outside=join(dir,'outside');mkdirSync(outside);
    if(process.platform!=='win32')symlinkSync(outside,join(root,'20261007-100006-1'));
    assert.deepEqual(pruneWindowsCases(root),['20261007-100003-1','20261007-100001-1']);
    assert.ok(existsSync(join(root,'20261007-100002-1')));
    assert.ok(existsSync(unowned));assert.ok(existsSync(backup));assert.ok(existsSync(outside));
    assert.deepEqual(pruneWindowsCases(root),[]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
