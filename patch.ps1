<#
.SYNOPSIS
  Spot-Lyric for Spotify - Windows launcher (macOS / Linux: patch.sh).

.DESCRIPTION
  Everything is done by the spot-lyric program (cmd/spot-lyric, the same on every
  system); this script only gets it and passes all arguments on:
    - in a checkout with Go installed: built from source;
    - otherwise: the prebuilt binary of this version from GitHub Releases (built by CI).

.EXAMPLE
  .\patch.cmd                      # guided install (asks step by step)
  .\patch.cmd --mode local -y      # pure local with the local service, no questions
  .\patch.cmd --help
  irm https://raw.githubusercontent.com/dibin666/spotify-patch-lryic/main/patch.ps1 | iex
#>
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less files in the ANSI code
# page, and a BOM breaks "irm | iex". All user-facing (Chinese) text comes from spot-lyric.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar

$Repo = 'dibin666/spotify-patch-lryic'
$Root = $PSScriptRoot      # empty when run through "irm ... | iex"
$Arguments = @($args)

function Fail([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Red; throw $Text }
function Say([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Green }

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = if ($arch -eq 'ARM64') { 'arm64' } else { 'amd64' }
$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }
$cache = Join-Path $base 'SpotLyric\cache'

function Get-SpotLyric {
    if ($env:SPOT_LYRIC_BIN) { return $env:SPOT_LYRIC_BIN }
    $null = New-Item -ItemType Directory -Force -Path $cache
    $version = ''
    if ($Root -and (Test-Path -LiteralPath (Join-Path $Root 'VERSION'))) {
        $version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -Raw).Trim()
    }
    # A checkout + Go: build exactly this source.
    if ($Root -and (Test-Path -LiteralPath (Join-Path $Root 'go.mod')) -and $env:SPOT_LYRIC_BUILD -ne '0' -and (Get-Command go -ErrorAction SilentlyContinue)) {
        $bin = Join-Path $cache 'spot-lyric-dev.exe'
        Push-Location $Root
        try {
            $env:CGO_ENABLED = '0'
            & go build -trimpath -o "$bin.tmp" ./cmd/spot-lyric
            if ($LASTEXITCODE -eq 0) { Move-Item -LiteralPath "$bin.tmp" -Destination $bin -Force; return $bin }
            Say 'Building from source failed; downloading the prebuilt program instead'
        }
        finally { Pop-Location }
    }
    $asset = "spot-lyric-windows-$arch.exe"
    $tags = @()
    if ($version) { $tags += "v$version" }
    $tags += 'latest'
    foreach ($tag in $tags) {
        $url = if ($tag -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$tag" }
        $bin = Join-Path $cache ($asset -replace '\.exe$', "-$tag.exe")
        if ($tag -ne 'latest' -and (Test-Path -LiteralPath $bin)) { return $bin }
        Say "Downloading $asset ($tag)..."
        try { Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile "$bin.tmp" } catch { Remove-Item -LiteralPath "$bin.tmp" -Force -ErrorAction SilentlyContinue; continue }
        try {
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS").Content
            if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
            $line = $sums -split "`n" | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($asset) + '\s*$') } | Select-Object -First 1
            if ($line) {
                $want = ($line -split '\s+')[0].ToLower()
                $have = (Get-FileHash -Algorithm SHA256 -LiteralPath "$bin.tmp").Hash.ToLower()
                if ($want -ne $have) { Remove-Item -LiteralPath "$bin.tmp" -Force; Fail "$asset failed verification (SHA256 mismatch)" }
            }
        }
        catch [System.Net.WebException] { }
        Unblock-File -LiteralPath "$bin.tmp" -ErrorAction SilentlyContinue
        Move-Item -LiteralPath "$bin.tmp" -Destination $bin -Force
        return $bin
    }
    Fail "Cannot download spot-lyric from https://github.com/$Repo/releases. Install Go and run this script inside the repository to build it from source."
}

$exe = Get-SpotLyric
& $exe @Arguments
$code = $LASTEXITCODE
# "irm | iex" runs in the caller's session: exiting would close the user's window.
if ($PSCommandPath) { exit $code }
