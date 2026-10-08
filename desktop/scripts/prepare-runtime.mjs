import { cpSync,copyFileSync,mkdirSync,existsSync,chmodSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const desktop=resolve(import.meta.dirname,'..'),root=resolve(desktop,'..'),resources=join(desktop,'src-tauri/resources');
mkdirSync(join(resources,'runtime'),{recursive:true});mkdirSync(join(resources,'bin'),{recursive:true});
for(const entry of ['src','scripts','package.json','package-lock.json'])cpSync(join(root,entry),join(resources,'runtime',entry),{recursive:true});
// Dependencies and the exact Node 22 executable travel with the application.
cpSync(join(root,'node_modules'),join(resources,'runtime/node_modules'),{recursive:true});
copyFileSync(process.execPath,join(resources,'bin',process.platform==='win32'?'node.exe':'node'));
const nodeLicense=join(dirname(process.execPath),process.platform==='win32'?'LICENSE':'../LICENSE');
if(existsSync(nodeLicense))copyFileSync(nodeLicense,join(resources,'bin/Node-LICENSE.txt'));
if(existsSync(join(root,'LICENSE')))copyFileSync(join(root,'LICENSE'),join(resources,'runtime/LICENSE'));
if(process.platform==='darwin'){
  const cache=join(root,'.ci-sandbox/swift-cache');mkdirSync(cache,{recursive:true});
  const run=(source,out,target)=>execFileSync('/usr/bin/swiftc',['-O',...(target?['-target',target]:[]),'-module-cache-path',cache,source,'-o',join(resources,'bin',out)],{stdio:'inherit',env:{...process.env,CLANG_MODULE_CACHE_PATH:cache}});
  run(join(desktop,'native/MacCollector.swift'),'macos-collector',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.0`);
  // SpeechAnalyzer and DictationTranscriber require macOS 26. Never compile on users' computers.
  execFileSync('/usr/bin/swiftc',['-parse-as-library','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos26.0`,'-module-cache-path',cache,join(root,'src/transcription/AppleTranscribe.swift'),'-o',join(resources,'bin/apple-transcribe')],{stdio:'inherit'});
  for(const name of ['node','macos-collector','apple-transcribe']){chmodSync(join(resources,'bin',name),0o755);execFileSync('/usr/bin/codesign',['--force','--sign','-',join(resources,'bin',name)],{stdio:'inherit'});}
}
if(!existsSync(join(desktop,'src-tauri/icons/icon.ico')))execFileSync(process.execPath,[join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'icon',join(desktop,'icon.svg'),'-o',join(desktop,'src-tauri/icons')],{cwd:desktop,stdio:'inherit'});
console.log('Bundled runtime prepared. No installation or live-data access performed.');
