$ErrorActionPreference = 'Stop'
$credential = "protocol=https`nhost=github.com`n`n" | git credential fill
$password = ($credential | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (!$password) { throw 'GitHub credentials unavailable' }
$headers = @{ Authorization="Bearer $password"; Accept='application/vnd.github+json'; 'User-Agent'='NodeAtlas-release' }
$base = 'https://api.github.com/repos/stargazerwna/nodesatlas'
$body = @{
  tag_name='v1.4.0'; name='NodeAtlas 1.4.0'; draft=$true; prerelease=$false
  body="Add ``Import Dude nodes`` to import devices and links from MikroTik Dude Devices/Links CSV exports, deduping devices by IP across maps and pairing link rows per map.`n`n### Fixed`n- Keep the Dude/Wind import dialogs open during live metric refreshes so the file picker selection isn't lost.`n- Show the selected file name in the Dude import dialog and read the chosen files reliably after re-render.`n- Dedupe re-imported Dude links by endpoint pair instead of a generated id, so re-importing the same export doesn't create duplicate links.`n`nDownload NodeAtlas-1.4.0-portable.exe below."
} | ConvertTo-Json
$release = Invoke-RestMethod "$base/releases" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$exe = Join-Path $PSScriptRoot '../dist-electron/NodeAtlas-1.4.0-portable.exe'
$upload = $release.upload_url -replace '\{.*$', ''
$asset = Invoke-RestMethod "${upload}?name=NodeAtlas-1.4.0-portable.exe" -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $exe -TimeoutSec 600
if ($asset.size -ne (Get-Item $exe).Length) { throw 'Uploaded asset size mismatch' }
$release = Invoke-RestMethod "$base/releases/$($release.id)" -Method Patch -Headers $headers -ContentType 'application/json' -Body (@{draft=$false; make_latest='true'} | ConvertTo-Json)
$latest = Invoke-RestMethod "$base/releases/latest" -Headers $headers
if ($latest.tag_name -ne 'v1.4.0') { throw 'Latest release verification failed' }
[pscustomobject]@{ url=$release.html_url; tag=$latest.tag_name; asset=$asset.browser_download_url; size=$asset.size } | ConvertTo-Json
