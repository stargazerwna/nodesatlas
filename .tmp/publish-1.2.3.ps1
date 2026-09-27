$ErrorActionPreference = 'Stop'
$credential = "protocol=https`nhost=github.com`n`n" | git credential fill
$password = ($credential | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (!$password) { throw 'GitHub credentials unavailable' }
$headers = @{ Authorization="Bearer $password"; Accept='application/vnd.github+json'; 'User-Agent'='NodeAtlas-release' }
$base = 'https://api.github.com/repos/stargazerwna/nodesatlas'
$body = @{
  tag_name='v1.2.3'; name='NodeAtlas 1.2.3'; draft=$true; prerelease=$false
  body="Fixes Import Wind nodes in the desktop app by replacing the unsupported browser prompt with an in-app domain form.`n`n- Preserves the domain during metric refresh and supports cancellation.`n- Excludes saved local network and workspace configuration from the portable download.`n`nDownload NodeAtlas-1.2.3-portable.exe below."
} | ConvertTo-Json
$release = Invoke-RestMethod "$base/releases" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$exe = Join-Path $PSScriptRoot '../dist-electron/NodeAtlas-1.2.3-portable.exe'
$upload = $release.upload_url -replace '\{.*$', ''
$asset = Invoke-RestMethod "${upload}?name=NodeAtlas-1.2.3-portable.exe" -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $exe -TimeoutSec 600
if ($asset.size -ne (Get-Item $exe).Length) { throw 'Uploaded asset size mismatch' }
$release = Invoke-RestMethod "$base/releases/$($release.id)" -Method Patch -Headers $headers -ContentType 'application/json' -Body (@{draft=$false; make_latest='true'} | ConvertTo-Json)
$latest = Invoke-RestMethod "$base/releases/latest" -Headers $headers
if ($latest.tag_name -ne 'v1.2.3') { throw 'Latest release verification failed' }
[pscustomobject]@{ url=$release.html_url; tag=$latest.tag_name; asset=$asset.browser_download_url; size=$asset.size } | ConvertTo-Json
