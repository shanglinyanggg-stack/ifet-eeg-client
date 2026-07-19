param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AlgorithmDir = Join-Path $Root "src-tauri\resources\SleepStagingAlgorithm_PC_v1.2.0"
$BuildDir = Join-Path $Root "output\windows-algorithm-runtime"
$DistDir = Join-Path $BuildDir "dist"
$WorkDir = Join-Path $BuildDir "work"
$SpecDir = Join-Path $BuildDir "spec"

if (-not $Python) {
    $Python = Join-Path $Root "output\build-tools\sleep-service-venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $Python)) {
    throw "Python build environment not found: $Python"
}

& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name ifet-sleep-service `
    --paths (Join-Path $AlgorithmDir "sdk") `
    --add-data "$(Join-Path $AlgorithmDir 'config');config" `
    --add-data "$(Join-Path $AlgorithmDir 'models');models" `
    --distpath $DistDir `
    --workpath $WorkDir `
    --specpath $SpecDir `
    (Join-Path $AlgorithmDir "service.py")

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

$BuiltRuntime = Join-Path $DistDir "ifet-sleep-service.exe"
$BundledRuntime = Join-Path $AlgorithmDir "runtime\ifet-sleep-service.exe"
# 全新克隆中 runtime/ 目录不存在（被 gitignore），先创建
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BundledRuntime) | Out-Null
Copy-Item -LiteralPath $BuiltRuntime -Destination $BundledRuntime -Force

& $Python (Join-Path $Root "scripts\update_algorithm_runtime_manifest.py") `
    --algorithm-dir $AlgorithmDir `
    --runtime $BundledRuntime `
    --target "Windows x64 desktop App" `
    --platform "Windows" `
    --arch "x86_64"

if ($LASTEXITCODE -ne 0) {
    throw "Runtime manifest update failed with exit code $LASTEXITCODE"
}
