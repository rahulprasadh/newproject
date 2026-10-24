# Downloads the current Node.js LTS for Windows as a zip (no installer, no admin rights) into
# <Dest>\node, after checking it against the SHA-256 list that nodejs.org publishes.
# Used by start.bat when Node.js is not installed.
param([string]$Dest = (Join-Path $PSScriptRoot '..\runtime'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}
# behind a company proxy: the system proxy with the signed-in user's credentials
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch {}

$fallback = 'v24.22.1'   # used only if the release list cannot be read
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist'
$version = $null
$name = $null

try {
  try {
    $index = Invoke-RestMethod -Uri "$base/index.json" -UseBasicParsing
    $release = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
    if ($release) { $version = $release.version }
  } catch {
    Write-Host "Could not read the Node.js release list ($($_.Exception.Message)); trying $fallback."
  }
  if (-not $version) { $version = $fallback }

  $name = "node-$version-win-$arch"
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $Dest = (Resolve-Path $Dest).Path
  $zip = Join-Path $env:TEMP "$name.zip"
  $sums = Join-Path $env:TEMP "$name-SHASUMS256.txt"

  Write-Host "Downloading Node.js $version ($arch) from nodejs.org ..."
  Invoke-WebRequest -Uri "$base/$version/$name.zip" -OutFile $zip -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$version/SHASUMS256.txt" -OutFile $sums -UseBasicParsing

  $line = Get-Content $sums | Where-Object { $_ -match ('\s' + [regex]::Escape("$name.zip") + '$') } | Select-Object -First 1
  if (-not $line) { throw "nodejs.org lists no checksum for $name.zip" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  if ($expected -ne $actual) { throw "the download is damaged (its SHA-256 does not match nodejs.org's list). Run start.bat again." }
  Write-Host "Checksum OK. Unpacking ..."

  $tmp = Join-Path $Dest '_unpack'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  # tar (built into Windows 10 and 11) is much faster than Expand-Archive
  $unpacked = $false
  if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # a warning from tar must not stop the script
    try {
      & tar.exe -xf $zip -C $tmp 2>&1 | Out-Null
      $unpacked = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $tmp "$name\node.exe"))
    } catch {
      $unpacked = $false
    } finally {
      $ErrorActionPreference = $eap
    }
  }
  if (-not $unpacked) {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
  }
  $target = Join-Path $Dest 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Move-Item (Join-Path $tmp $name) $target
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip, $sums -Force -ErrorAction SilentlyContinue

  $v = & (Join-Path $target 'node.exe') -v
  Write-Host "Node.js $v is ready in $target"
  exit 0
} catch {
  Write-Host ""
  Write-Host "Could not set up Node.js: $($_.Exception.Message)"
  $n = if ($name) { $name } else { "node-$fallback-win-$arch" }
  $ver = if ($version) { $version } else { $fallback }
  Write-Host "To do it by hand: download $base/$ver/$n.zip in your browser, extract it, rename the"
  Write-Host "extracted folder to 'node' and put it in: $Dest  (so that $Dest\node\node.exe exists)."
  exit 1
}
