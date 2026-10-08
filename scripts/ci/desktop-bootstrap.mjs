// Scaffold only: this repository does not contain the React/Tauri app yet.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const target = process.env.BOOTSTRAP_TARGET;
const expectedArch = process.env.BOOTSTRAP_ARCH;
const commit = process.env.BOOTSTRAP_COMMIT;
const targets = {
  'macos-arm64': { platform: 'darwin', arch: 'arm64' },
  'windows-x64': { platform: 'win32', arch: 'x64' },
};
assert.ok(Object.hasOwn(targets, target), 'Unknown bootstrap target');
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Expected a Git commit SHA');
assert.equal(process.platform, targets[target].platform, 'Unexpected runner platform');
assert.equal(expectedArch, targets[target].arch, 'Unexpected target architecture');
assert.equal(process.arch, expectedArch, 'Unexpected runner architecture');

// Confirm that the selected Node runtime supports the SQLite backend.
const db = new DatabaseSync(':memory:');
try {
  assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1);
} finally {
  db.close();
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/desktop-bootstrap.json', JSON.stringify({
  stage: 'bootstrap',
  appBuilt: false,
  reason: 'Desktop React/Tauri project and native collectors are not wired into this repository yet.',
  commit,
  target,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  sqliteSmokeTest: 'passed',
}, null, 2) + '\n');
console.log('Bootstrap validated. Manifest created; no desktop application was built.');
