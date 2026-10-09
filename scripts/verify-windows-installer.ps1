$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Bundle = Join-Path $Root "src-tauri\target\release\bundle"
$Installer = Get-ChildItem -LiteralPath (Join-Path $Bundle "nsis") -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Installer) { throw "Windows EXE installer not found" }
$InstallRoot = Join-Path $env:TEMP ("ifet-stimulus-installer-check-" + [guid]::NewGuid().ToString())
$Install = Start-Process -FilePath $Installer.FullName -ArgumentList "/S /D=$InstallRoot" -Wait -PassThru
if ($Install.ExitCode -ne 0) { throw "Installer failed: $($Install.ExitCode)" }
$Application = Join-Path $InstallRoot "ifet-eeg-client.exe"
if (-not (Test-Path -LiteralPath $Application)) { throw "Installed application is missing: $Application" }
$Required = @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")
$Libraries = @()
foreach ($Name in $Required) {
    $File = Join-Path $InstallRoot $Name
    if (-not (Test-Path -LiteralPath $File)) { throw "Missing app-local CRT: $Name" }
    $Libraries += [pscustomobject]@{ name=$Name; sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash; signature=(Get-AuthenticodeSignature -LiteralPath $File).Status.ToString() }
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
        if ($Process.MainWindowTitle -eq "iFET EEG Client Stimulus 0.3.1" -and $Process.MainWindowHandle -ne 0) { $Ready=$true; break }
    }
    if (-not $Ready) { throw "Installed application did not create its expected main window (possible loader or WebView2 failure)" }
    Start-Sleep -Seconds 3
    $Process.Refresh()
    if ($Process.HasExited) { throw "Installed application exited after initial window creation" }
    $Report = [pscustomobject]@{
        schema="ifet-windows-installer-check/v1"; installer=$Installer.Name; installExitCode=$Install.ExitCode;
        version="0.3.1"; appWindowTitle=$Process.MainWindowTitle; appStartupPassed=$true;
        appLocalCrt=$Libraries; algorithmSidecarPresent=$true;
        bleHardwareTested=$false; audioLoopbackTested=$false; opticalTimingTested=$false; ttlPinTested=$false
    }
    $Json = $Report | ConvertTo-Json -Depth 6 -Compress
    Set-Content -LiteralPath (Join-Path $Bundle "windows-installer-verification.json") -Value $Json -Encoding UTF8
    Write-Output "IFET_WINDOWS_INSTALLER_VERIFIED=$Json"
} finally {
    if ($Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force; $Process.WaitForExit() }
}
