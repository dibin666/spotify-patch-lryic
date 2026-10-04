# patch.ps1 on a synthetic xpui.spa under the running PowerShell (Windows PowerShell 5.1 in CI):
# inject, no-op, mode change, restore byte-identical. Uses a throw-away data directory.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\patch_test.ps1
$ErrorActionPreference = 'Stop'
# Child output (patch.ps1 writes UTF-8) must be decoded as UTF-8 to match the Chinese messages.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ('spot-lyric-test-' + [Guid]::NewGuid().ToString('N'))
$apps = Join-Path (Join-Path $work 'Spotify') 'Apps'
$null = New-Item -ItemType Directory -Force -Path $apps
$env:SPOT_LYRIC_DATA = Join-Path $work 'data'
$spa = Join-Path $apps 'xpui.spa'
$zip = [IO.Compression.ZipFile]::Open($spa, [IO.Compression.ZipArchiveMode]::Create)
foreach ($e in @(@('index.html', '<html><body><div id="main"></div></body></html>'), @('xpui.js', ('x' * 5000)))) {
    $w = New-Object IO.StreamWriter($zip.CreateEntry($e[0]).Open()); $w.Write($e[1]); $w.Dispose()
}
$zip.Dispose()
$original = (Get-FileHash $spa).Hash
$fail = 0
function Check([string]$Name, [bool]$Ok) { if ($Ok) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ } }
$shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName   # same PowerShell as this test
function Run { $out = & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'patch.ps1') @args 2>&1 | Out-String; Write-Host $out; return $out }
function Index { $z = [IO.Compression.ZipFile]::OpenRead($spa); try { (New-Object IO.StreamReader($z.GetEntry('index.html').Open())).ReadToEnd() } finally { $z.Dispose() } }
function Bundle { $z = [IO.Compression.ZipFile]::OpenRead($spa); try { (New-Object IO.StreamReader($z.GetEntry('spot-lyric/spot-lyric.js').Open())).ReadToEnd() } finally { $z.Dispose() } }
$dir = Split-Path -Parent $apps

$out = Run apply --yes --mode cloud --no-restart --spotify-path $dir
Check 'apply injects' ($out -match '已注入')
Check 'one marked block' (([regex]::Matches((Index), 'spot-lyric:start')).Count -eq 1)
Check 'cloud mode baked in' ((Bundle).Contains("const PATCH_MODE = 'cloud'") -and (Bundle).Contains("const PATCH_REQUEST = 'server'"))
$out = Run apply --yes --mode cloud --no-restart --spotify-path $dir
Check 'second apply is a no-op' ($out -match '无需修改')
$out = Run apply --yes --mode cloud --request service --no-restart --spotify-path $dir
Check 'cloud mode with the local service' ((Bundle).Contains("const PATCH_REQUEST = 'service'"))
$out = Run apply --yes --mode local --no-restart --spotify-path $dir
Check 'pure local build' ((Bundle).Contains("const PATCH_MODE = 'local'"))
Check 'apply never fetches the local service' (-not (Test-Path (Join-Path $env:SPOT_LYRIC_DATA 'spot-lyric-server.exe')))
$out = Run status --spotify-path $dir
Check 'status' ($out -match '已注入')
$out = Run restore --no-restart --spotify-path $dir
Check 'restore' ($out -match '已还原')
Check 'restored byte-identical' ((Get-FileHash $spa).Hash -eq $original)
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
if ($fail) { Write-Host "$fail failed"; exit 1 }
Write-Host 'all passed'
