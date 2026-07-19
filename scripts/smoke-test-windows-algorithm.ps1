param(
    [int]$Port = 18765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root "src-tauri\resources\SleepStagingAlgorithm_PC_v1.2.0\runtime\ifet-sleep-service.exe"
$StatePath = Join-Path $Root "output\windows-algorithm-runtime\smoke-state.npz"
$Endpoint = "http://127.0.0.1:$Port"
$Process = Start-Process `
    -FilePath $Runtime `
    -ArgumentList @("--host", "127.0.0.1", "--port", $Port, "--state-path", $StatePath, "--no-restore") `
    -WindowStyle Hidden `
    -PassThru

try {
    $Health = $null
    for ($Attempt = 0; $Attempt -lt 80; $Attempt += 1) {
        try {
            $Health = Invoke-RestMethod -Uri "$Endpoint/health" -Method Get -TimeoutSec 2
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $Health) {
        throw "Algorithm service did not become ready"
    }
    if ($Health.demo.schema_version -ne "headset-demo-flags/v7") {
        throw "Unexpected demo schema: $($Health.demo.schema_version)"
    }
    if ($Health.demo.algorithm_version -ne "1.0.13") {
        throw "Unexpected blink algorithm version: $($Health.demo.algorithm_version)"
    }
    if ($Health.demo.blink_calibration_seconds -ne 10) {
        throw "Unexpected blink calibration duration"
    }
    if ($Health.demo.blink_quiet_baseline_seconds -ne 3) {
        throw "Unexpected blink quiet baseline duration"
    }

    $SessionId = "windows-sidecar-smoke"
    $Reset = Invoke-RestMethod `
        -Uri "$Endpoint/demo/reset" `
        -Method Post `
        -ContentType "application/json" `
        -Body (@{ session_id = $SessionId; blink_interaction_enabled = $true } | ConvertTo-Json)
    if ($Reset.state.blink_calibration_status -ne "idle") {
        throw "Blink calibration must remain idle until explicitly started"
    }

    $Calibration = Invoke-RestMethod `
        -Uri "$Endpoint/demo/blink-calibration" `
        -Method Post `
        -ContentType "application/json" `
        -Body (@{ session_id = $SessionId; action = "start" } | ConvertTo-Json)
    if ($Calibration.state.blink_calibration_status -ne "running") {
        throw "Blink calibration did not start"
    }

    $Configured = Invoke-RestMethod `
        -Uri "$Endpoint/demo/config" `
        -Method Post `
        -ContentType "application/json" `
        -Body (@{ session_id = $SessionId; alpha_volume_mode = "10"; session_active = $false } | ConvertTo-Json)
    if ($Configured.telemetry.alpha_volume_mode -ne "10") {
        throw "Alpha volume mode did not update"
    }

    [pscustomobject]@{
        service = $Health.service
        schema = $Health.demo.schema_version
        blinkAlgorithm = $Health.demo.algorithm_version
        calibrationSeconds = $Health.demo.blink_calibration_seconds
        calibrationStatus = $Calibration.state.blink_calibration_status
        alphaVolumeMode = $Configured.telemetry.alpha_volume_mode
    } | ConvertTo-Json -Compress
} finally {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit()
    }
}
