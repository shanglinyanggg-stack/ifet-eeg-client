$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
python -m venv (Join-Path $Root ".venv")
& (Join-Path $Root ".venv\Scripts\python.exe") -m pip install --upgrade pip
& (Join-Path $Root ".venv\Scripts\python.exe") -m pip install -r (Join-Path $Root "requirements-runtime.txt")
Write-Host "Runtime installed. Run start_service.ps1 next."
