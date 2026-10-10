// Keep validation in the build command so the existing CI workflow needs no changes.
const {run,logError} = require('@tauri-apps/cli/main');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const args = process.argv.slice(2);
function checked(command, parameters) {
  const result=spawnSync(command,parameters,{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} failed (${result.status})`);
}
run(args,'npm run tauri').then(()=>{
  if(process.platform!=='win32'||args[0]!=='build'||args.includes('--no-bundle'))return;
  checked('cargo',['test','--locked','--release','--manifest-path','src-tauri/Cargo.toml','--lib']);
  checked('cargo',['build','--locked','--release','--manifest-path','tools/matlab_bridge_probe/Cargo.toml']);
  checked('python',['scripts/benchmark_matlab_bridge.py','--binary','tools/matlab_bridge_probe/target/release/matlab_bridge_probe.exe','--output','output/windows-matlab-bridge-probe']);
  const report=JSON.parse(fs.readFileSync(path.join(root,'output/windows-matlab-bridge-probe/latency_report.json'),'utf8'));
  delete report.events;
  console.log('IFET_WINDOWS_RECEIVER_LOOPBACK='+JSON.stringify(report));
  const parameters=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'verify-windows-installer.ps1')];
  const shell=spawnSync('pwsh.exe',parameters,{cwd:root,stdio:'inherit'});
  if(shell.error?.code==='ENOENT')checked('powershell.exe',parameters);
  else {
    if(shell.error)throw shell.error;
    if(shell.status!==0)throw new Error(`Windows installer verification failed (${shell.status})`);
  }
}).catch(error=>{logError(error.message);process.exitCode=1;});
