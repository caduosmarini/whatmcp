import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('Windows PowerShell scripts parse without executing extraction or scheduling', {skip:process.platform!=='win32'},()=>{
  for(const file of ['sync-hotcopy-windows.ps1','register-hotcopy-task.ps1']) {
    const path=fileURLToPath(new URL(`../scripts/${file}`,import.meta.url));
    const command=`$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'","''")}',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'pipe'});
  }
});
