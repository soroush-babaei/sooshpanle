$B = "http://127.0.0.1:8000"
$login = Invoke-RestMethod -Method Post -Uri "$B/api/login" -ContentType "application/json" -Body '{"username":"admin","password":"test1234"}'
$H = @{ Authorization = "Bearer $($login.token)" }
$users = Invoke-RestMethod -Uri "$B/api/users" -Headers $H
$u1 = $users | Where-Object { $_.username -eq 'mci-test' }
$tok1 = $u1.sub_url.Split('/sub/')[1]

"=== SUB (WS, TLS) ==="
$sub1 = Invoke-WebRequest -UseBasicParsing "$B/sub/$tok1"
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sub1.Content))
$decoded

"=== QR ==="
$qr = Invoke-WebRequest -UseBasicParsing "$B/sub/$tok1/qr"
"content-type=$($qr.Headers['Content-Type']) len=$($qr.Content.Length) head=$($qr.Content.Substring(0,60))"

"=== XRAY CONFIG ==="
$cfg = Get-Content "d:\other\iNTERNET\SooshPanle\xray\config.json" -Raw | ConvertFrom-Json
$cfg.inbounds | ForEach-Object {
    $emails = ($_.settings.clients | ForEach-Object { $_.email }) -join ','
    "$($_.tag): port=$($_.port) clients=[$emails]"
}
"policy: " + ($cfg.policy.levels.'0' | ConvertTo-Json -Compress)

"=== 2FA FLOW ==="
$tfa = Invoke-RestMethod -Uri "$B/api/2fa/setup" -Headers $H
"totp secret len=$($tfa.secret.Length)"
$py = "d:\other\iNTERNET\SooshPanle\backend\.venv\Scripts\python.exe"
$code = & $py -c "import pyotp; print(pyotp.TOTP('$($tfa.secret)').now())"
$en = Invoke-RestMethod -Method Post -Uri "$B/api/2fa/enable" -Headers $H -ContentType "application/json" -Body ('{"code":"' + $code + '"}')
"2FA enabled: $($en.ok)"
try { Invoke-RestMethod -Method Post -Uri "$B/api/login" -ContentType "application/json" -Body '{"username":"admin","password":"test1234"}' | Out-Null; "LOGIN-WITHOUT-TOTP: UNEXPECTED SUCCESS" } catch { "LOGIN-WITHOUT-TOTP: blocked ($($_.Exception.Response.StatusCode.value__))" }
$code2 = & $py -c "import pyotp; print(pyotp.TOTP('$($tfa.secret)').now())"
$lg = Invoke-RestMethod -Method Post -Uri "$B/api/login" -ContentType "application/json" -Body ('{"username":"admin","password":"test1234","totp":"' + $code2 + '"}')
"LOGIN-WITH-TOTP: ok, token len=$($lg.token.Length)"

"=== QUOTA/EXPIRY LOGIC ==="
$bad = Invoke-RestMethod -Method Post -Uri "$B/api/users" -Headers $H -ContentType "application/json" -Body '{"username":"quota-test","traffic_limit_gb":0.000001,"expiry_days":1,"inbound":"ws"}'
"created quota-test id=$($bad.id)"
$stats = Invoke-RestMethod -Uri "$B/api/stats" -Headers $H
$stats.users | ForEach-Object { "$($_.username): active=$($_.active) expired=$($_.expired) quota=$($_.quota_exceeded)" }
$tokBad = ($stats.users | Where-Object { $_.username -eq 'quota-test' })
try { Invoke-WebRequest -UseBasicParsing "$B/sub/$tokBad" | Out-Null; "SUB-QUOTA-USER: UNEXPECTED OK" } catch { "SUB-QUOTA-USER: correctly rejected" }