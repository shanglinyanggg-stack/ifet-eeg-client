const {run,logError} = require('@tauri-apps/cli/main');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
run(args,'npm run tauri').then(()=>{
  if (process.platform==='win32' && args[0]==='build' && !args.includes('--no-bundle')) {
    const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'verify-windows-installer.ps1')],{stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`Windows installer verification failed (${result.status})`);
  }
}).catch(error=>{logError(error.message);process.exitCode=1;});
