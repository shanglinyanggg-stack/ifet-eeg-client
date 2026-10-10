$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop
function Get-Sha256Hex([string]$Path) {
    $Stream = [System.IO.File]::OpenRead($Path)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "") }
    finally { $Hasher.Dispose(); $Stream.Dispose() }
}
$Root = Split-Path -Parent $PSScriptRoot
$Bundle = Join-Path $Root "src-tauri\target\release\bundle"
$Installer = Get-ChildItem -LiteralPath (Join-Path $Bundle "nsis") -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Installer) { throw "Windows EXE installer not found" }
$InstallRoot = Join-Path $env:TEMP ("ifet-matlab-bridge-installer-check-" + [guid]::NewGuid().ToString())
$Install = Start-Process -FilePath $Installer.FullName -ArgumentList "/S /D=$InstallRoot" -Wait -PassThru
if ($Install.ExitCode -ne 0) { throw "Installer failed: $($Install.ExitCode)" }
$Application = Join-Path $InstallRoot "ifet-eeg-client.exe"
if (-not (Test-Path -LiteralPath $Application)) { throw "Installed application is missing" }
$Required = @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")
$Libraries = @()
foreach ($Name in $Required) {
    $File = Join-Path $InstallRoot $Name
    if (-not (Test-Path -LiteralPath $File)) { throw "Missing app-local CRT: $Name" }
    $Signature = (Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $File).Status.ToString()
    if ($Signature -ne "Valid") { throw "Invalid Microsoft CRT signature: $Name ($Signature)" }
    $Libraries += [pscustomobject]@{ name=$Name; sha256=(Get-Sha256Hex $File); signature=$Signature }
}
$Algorithm = Join-Path $InstallRoot "resources\SleepStagingAlgorithm_PC_v1.2.0\runtime\ifet-sleep-service.exe"
if (-not (Test-Path -LiteralPath $Algorithm)) { throw "Installed algorithm sidecar is missing" }
$Process = Start-Process -FilePath $Application -PassThru
try {
    $Ready = $false
    for ($Attempt=0; $Attempt -lt 120; $Attempt++) {
        Start-Sleep -Milliseconds 250
        $Process.Refresh()
        if ($Process.HasExited) { throw "Installed application exited during startup: $($Process.ExitCode)" }
        if ($Process.MainWindowTitle -eq "iFET EEG Client MATLAB Bridge 0.4.0" -and $Process.MainWindowHandle -ne 0) { $Ready=$true; break }
    }
    if (-not $Ready) { throw "Installed application did not create its expected main window" }
    Start-Sleep -Seconds 3
    $Process.Refresh()
    if ($Process.HasExited) { throw "Installed application exited after window creation" }
    $Report = [pscustomobject]@{
        schema="ifet-windows-installer-check/v1"; installer=$Installer.Name; installExitCode=$Install.ExitCode;
        version="0.4.0"; product="MATLAB Bridge"; installerSha256=(Get-Sha256Hex $Installer.FullName);
        appWindowTitle=$Process.MainWindowTitle; appStartupPassed=$true; appLocalCrt=$Libraries;
        algorithmSidecarPresent=$true; bleHardwareTested=$false; matlabPsychtoolboxTested=$false;
        physicalAudioOrOpticalTimingTested=$false; physicalTtlTested=$false
    }
    $Json = $Report | ConvertTo-Json -Depth 6 -Compress
    Set-Content -LiteralPath (Join-Path $Bundle "windows-installer-verification.json") -Value $Json -Encoding UTF8
    Write-Output "IFET_WINDOWS_INSTALLER_VERIFIED=$Json"
} finally {
    if ($Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force; $Process.WaitForExit() }
}
