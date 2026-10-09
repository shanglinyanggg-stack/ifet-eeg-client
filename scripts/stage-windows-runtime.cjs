// Copy only Microsoft's x64 redistributable CRT, never system DLLs or debug CRT.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(__dirname, '..');
const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {encoding:'utf8'}).trim();
if (!installation) throw new Error('Visual Studio C++ redistributables are required to build the installer');
const redist = path.join(installation, 'VC', 'Redist', 'MSVC');
const versions = fs.readdirSync(redist).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
const candidates = versions.flatMap(version=>{
  const directory=path.join(redist,version,'x64');
  return fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>/^Microsoft\.VC\d+\.CRT$/.test(name)).map(name=>path.join(directory,name)):[];
});
const source = candidates.find(folder=>fs.existsSync(path.join(folder,'msvcp140.dll')) && fs.existsSync(path.join(folder,'vcruntime140.dll')));
if (!source) throw new Error('Microsoft x64 release CRT not found; refusing to build an installer missing MSVCP140.dll');
const target = path.join(root,'src-tauri','target','windows-runtime');
fs.mkdirSync(target,{recursive:true});
const files = fs.readdirSync(source).filter(name=>name.toLowerCase().endsWith('.dll'));
for (const name of files) {
  const data = fs.readFileSync(path.join(source,name));
  const pe = data.readUInt32LE(0x3c);
  if (data.readUInt16LE(0)!==0x5a4d || data.readUInt32LE(pe)!==0x4550 || data.readUInt16LE(pe+4)!==0x8664) throw new Error(`Not an x64 PE DLL: ${name}`);
  fs.copyFileSync(path.join(source,name),path.join(target,name));
}
fs.writeFileSync(path.join(target,'WINDOWS_CRT_REDISTRIBUTION.txt'),
  'Microsoft Visual C++ x64 release CRT copied from the Visual Studio redistributable directory.\r\n'+
  'App-local deployment next to ifet-eeg-client.exe; no system DLLs or debug CRT are included.\r\n'+
  'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files\r\n'+
  'Redistribution is governed by the Microsoft Visual Studio software license and REDIST list.\r\n');
console.log(JSON.stringify({windowsCrtStaged:true,files,source}));
