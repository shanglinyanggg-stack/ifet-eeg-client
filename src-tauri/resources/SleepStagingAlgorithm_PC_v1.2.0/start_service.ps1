$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledRuntime = Join-Path $Root "runtime\ifet-sleep-service.exe"
if (Test-Path -LiteralPath $BundledRuntime) {
    & $BundledRuntime
    exit $LASTEXITCODE
}
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
    throw "Bundled runtime and Python fallback are both missing."
}
$env:PYTHONUTF8 = "1"
& $Python (Join-Path $Root "service.py")
