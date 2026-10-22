# Safe, portable API smoke test for a running local SooshPanel.
# Set credentials in the current PowerShell session; do not put real secrets in this file.
#   $env:SOOSHPANEL_BASE_URL = "http://127.0.0.1:8000"
#   $env:SOOSHPANEL_ADMIN_USERNAME = "admin"
#   $env:SOOSHPANEL_ADMIN_PASSWORD = "your-test-password"
#   $env:SOOSHPANEL_TOTP = "123456" # only if 2FA is enabled
#   .\scripts\test-api.ps1

$ErrorActionPreference = "Stop"
$Base = if ($env:SOOSHPANEL_BASE_URL) { $env:SOOSHPANEL_BASE_URL.TrimEnd('/') } else { "http://127.0.0.1:8000" }
$Username = $env:SOOSHPANEL_ADMIN_USERNAME
$Password = $env:SOOSHPANEL_ADMIN_PASSWORD
$Totp = $env:SOOSHPANEL_TOTP

Write-Host "SooshPanel API smoke test: $Base"
try {
    $docs = Invoke-WebRequest -UseBasicParsing -Uri "$Base/docs" -TimeoutSec 8
    Write-Host "[PASS] API docs reachable (HTTP $([int]$docs.StatusCode))"
} catch {
    throw "API is not reachable at $Base. Start the panel first and check container logs. $($_.Exception.Message)"
}

if (-not $Username -or -not $Password) {
    Write-Warning "Set SOOSHPANEL_ADMIN_USERNAME and SOOSHPANEL_ADMIN_PASSWORD to run authenticated API checks."
    exit 0
}

$body = @{ username = $Username; password = $Password }
if ($Totp) { $body.totp = $Totp }
try {
    $login = Invoke-RestMethod -Method Post -Uri "$Base/api/login" -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10
} catch {
    throw "Login failed. Check the test credentials and, if enabled, set a current SOOSHPANEL_TOTP. $($_.Exception.Message)"
}
if (-not $login.token) { throw "Login response did not include a token." }
$headers = @{ Authorization = "Bearer $($login.token)" }
Write-Host "[PASS] Login returned a token"

$users = Invoke-RestMethod -Uri "$Base/api/users" -Headers $headers -TimeoutSec 10
Write-Host "[PASS] GET /api/users returned $(@($users).Count) item(s)"
$stats = Invoke-RestMethod -Uri "$Base/api/stats" -Headers $headers -TimeoutSec 15
if ($null -eq $stats.users) { throw "GET /api/stats response did not include the users collection." }
Write-Host "[PASS] GET /api/stats returned $(@($stats.users).Count) user status record(s)"
if ($stats.stats_available -eq $false) {
    Write-Warning "Xray statistics are unavailable; quota enforcement has not been integration-verified."
}
Write-Host "Smoke test finished. This does not verify real client traffic, quota crossing, expiry synchronization, or simultaneous-device enforcement."
