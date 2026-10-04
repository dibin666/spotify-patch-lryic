#Requires -Version 5.1
<#
.SYNOPSIS
  Spot-Lyric for Spotify (Windows) - injects the third-party lyrics page into the Spotify desktop client.

.EXAMPLE
  .\patch.cmd                 # install: patch Spotify + restart Spotify (matching runs locally)
  .\patch.cmd -Server https://lyrics.example.com   # use a self-hosted lyrics server
  .\patch.cmd -Direct         # start Spotify with --disable-web-security: NetEase / QQ are requested
                              # directly instead of through the lyrics server relay (-NoDirect undoes it)
  .\patch.cmd status
  .\patch.cmd restore
  .\patch.cmd uninstall
  .\patch.cmd hook            # re-apply automatically at logon (after Spotify self-updates)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'apply', 'restore', 'uninstall', 'status', 'hook', 'unhook')]
    [string]$Command = 'install',
    [string]$SpotifyPath,
    [ValidatePattern('^https?://[A-Za-z0-9._~:/-]+$')][string]$Server = 'https://spo.564616.xyz',
    [switch]$NoRestart,
    [switch]$Restart,
    [switch]$Direct,
    [switch]$NoDirect,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Root = $PSScriptRoot
$Server = $Server.TrimEnd('/')
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Version = ([IO.File]::ReadAllText((Join-Path $Root 'VERSION'), $Utf8)).Trim()
# PowerShell 5.1 only exists on Windows; pwsh exposes $IsWindows. Non-Windows runs are for testing.
$OnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$DataDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'SpotLyric' } else { Join-Path $HOME '.spot-lyric-test' }
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AssetDir = 'spot-lyric'
$BackupSuffix = '.spot-lyric.bak'
$BlockPattern = '(?s)<!-- spot-lyric:start[^>]*-->.*?<!-- spot-lyric:end -->'
$MarkerPattern = '<!-- spot-lyric:start v(\S+) sha=(\w+) -->'

function Say([string]$Text) { if (-not $Quiet) { Write-Host "[spot-lyric] $Text" -ForegroundColor Green } }
function Warn([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------- detect ---
function Test-SpotifyDir([string]$Dir) {
    if (-not $Dir) { return $false }
    (Test-Path -LiteralPath (Join-Path $Dir 'Apps\xpui.spa') -PathType Leaf) -or
    (Test-Path -LiteralPath (Join-Path $Dir 'Apps\xpui\index.html') -PathType Leaf)
}

function Find-Spotify {
    if ($SpotifyPath) {
        if (Test-SpotifyDir $SpotifyPath) { return (Resolve-Path -LiteralPath $SpotifyPath).Path }
        Fail "指定目录不是 Spotify 安装目录：$SpotifyPath"
    }
    $candidates = @()
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'Spotify') }            # spotify.com installer (default)
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Spotify') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Spotify') }  # SpotifyFullSetup.exe /extract
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Spotify') }
    foreach ($dir in $candidates) { if (Test-SpotifyDir $dir) { return $dir } }
    if ($OnWindows -and (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) {
        if (Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue) {
            Fail ("检测到 Microsoft Store 版 Spotify：它安装在只读的 WindowsApps 目录，无法注入。`n" +
                  "请在「设置 > 应用」中卸载它，然后从 https://www.spotify.com/download 安装普通版本后重试。")
        }
    }
    return $null
}

function Get-SpotifyVersion([string]$Dir) {
    $exe = Join-Path $Dir 'Spotify.exe'
    if (Test-Path -LiteralPath $exe) {
        $v = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
        if ($v) { return $v }
    }
    return 'unknown'
}

# ---------------------------------------------------------------- build ---
function Get-Bundle {
    $core = [IO.File]::ReadAllText((Join-Path $Root 'src\core.js'), $Utf8)
    $app = [IO.File]::ReadAllText((Join-Path $Root 'src\app.js'), $Utf8)
    $app = $app.Replace('__SPOT_LYRIC_VERSION__', $Version).Replace('__SPOT_LYRIC_SERVER__', $Server)
    $js = "/* Spot-Lyric for Spotify v$Version - generated, do not edit */`n" + $core + "`n" + $app
    $css = [IO.File]::ReadAllText((Join-Path $Root 'src\app.css'), $Utf8)
    $jsBytes = $Utf8.GetBytes($js)
    $cssBytes = $Utf8.GetBytes($css)
    # Same digest as tools/xpui_patch.py: sha256(js + "\0" + css)[:16]
    $buffer = New-Object byte[] ($jsBytes.Length + 1 + $cssBytes.Length)
    [Array]::Copy($jsBytes, 0, $buffer, 0, $jsBytes.Length)
    [Array]::Copy($cssBytes, 0, $buffer, $jsBytes.Length + 1, $cssBytes.Length)
    $sha = [Security.Cryptography.SHA256]::Create()
    $digest = (-join ($sha.ComputeHash($buffer) | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
    $sha.Dispose()
    return @{ Js = $jsBytes; Css = $cssBytes; Digest = $digest }
}

function Get-Injection([string]$Digest) {
    "<!-- spot-lyric:start v$Version sha=$Digest -->" +
    "<link rel=`"stylesheet`" href=`"/$AssetDir/spot-lyric.css`">" +
    "<script defer=`"defer`" src=`"/$AssetDir/spot-lyric.js`"></script>" +
    '<!-- spot-lyric:end -->'
}

function Add-Injection([string]$Html, [string]$Digest) {
    $Html = [regex]::Replace($Html, $BlockPattern, '')
    $block = Get-Injection $Digest
    $at = $Html.IndexOf('</body>')
    if ($at -ge 0) { return $Html.Insert($at, $block) }
    return $Html + $block
}

function Get-Marker([string]$Html) {
    $m = [regex]::Match($Html, $MarkerPattern)
    if ($m.Success) { return "$($m.Groups[1].Value) $($m.Groups[2].Value)" }
    return $null
}

# ------------------------------------------------------------------ zip ---
function Read-ZipText([string]$Zip, [string]$Name) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $entry = $archive.GetEntry($Name)
        if ($null -eq $entry) { throw "$Name not found in $Zip" }
        $reader = New-Object IO.StreamReader($entry.Open(), $Utf8)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally { $archive.Dispose() }
}

function Write-ZipEntry($Archive, [string]$Name, [byte[]]$Bytes) {
    $stream = $Archive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal).Open()
    try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
}

# Builds the patched archive next to the target and swaps it in atomically.
function Write-PatchedSpa([string]$Source, [string]$Target, [string]$Html, $Assets) {
    $temp = Join-Path (Split-Path -Parent $Target) ('.xpui-' + [Guid]::NewGuid().ToString('N') + '.spa')
    Copy-Item -LiteralPath $Source -Destination $temp -Force
    try {
        $archive = [IO.Compression.ZipFile]::Open($temp, [IO.Compression.ZipArchiveMode]::Update)
        try {
            $stale = @($archive.Entries | Where-Object { $_.FullName -eq 'index.html' -or $_.FullName.StartsWith("$AssetDir/") })
            foreach ($entry in $stale) { $entry.Delete() }
            Write-ZipEntry $archive 'index.html' $Utf8.GetBytes($Html)
            foreach ($name in $Assets.Keys) { Write-ZipEntry $archive "$AssetDir/$name" $Assets[$name] }
        }
        finally { $archive.Dispose() }
        Move-Item -LiteralPath $temp -Destination $Target -Force
    }
    catch {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw
    }
}

# --------------------------------------------------------------- patch ----
function Invoke-Patch([string]$Dir) {
    $bundle = Get-Bundle
    $assets = [ordered]@{ 'spot-lyric.js' = $bundle.Js; 'spot-lyric.css' = $bundle.Css }
    $wanted = "$Version $($bundle.Digest)"
    $apps = Join-Path $Dir 'Apps'
    $folder = Join-Path $apps 'xpui'
    $index = Join-Path $folder 'index.html'
    if (Test-Path -LiteralPath $index -PathType Leaf) {
        # Extracted xpui directory (e.g. after spicetify / SpotX developer mode)
        $html = [IO.File]::ReadAllText($index, $Utf8)
        if ((Get-Marker $html) -eq $wanted) { return 'UNCHANGED' }
        $null = New-Item -ItemType Directory -Force -Path (Join-Path $folder $AssetDir)
        foreach ($name in $assets.Keys) { [IO.File]::WriteAllBytes((Join-Path (Join-Path $folder $AssetDir) $name), $assets[$name]) }
        [IO.File]::WriteAllText($index, (Add-Injection $html $bundle.Digest), $Utf8)
        return "PATCHED $folder"
    }
    $spa = Join-Path $apps 'xpui.spa'
    $backup = $spa + $BackupSuffix
    $html = Read-ZipText $spa 'index.html'
    $current = Get-Marker $html
    if ($current -eq $wanted) { return 'UNCHANGED' }
    if ($null -eq $current) {
        # Fresh (possibly freshly updated) archive from Spotify: it becomes the new original.
        Copy-Item -LiteralPath $spa -Destination $backup -Force
    }
    else {
        if (-not (Test-Path -LiteralPath $backup)) { Fail 'xpui.spa 已被修改但备份缺失，请重新安装 Spotify 后再试' }
        $html = Read-ZipText $backup 'index.html'
    }
    Write-PatchedSpa $backup $spa (Add-Injection $html $bundle.Digest) $assets
    return "PATCHED $spa"
}

function Invoke-Restore([string]$Dir) {
    $apps = Join-Path $Dir 'Apps'
    $folder = Join-Path $apps 'xpui'
    $index = Join-Path $folder 'index.html'
    $done = $false
    if (Test-Path -LiteralPath $index -PathType Leaf) {
        $html = [IO.File]::ReadAllText($index, $Utf8)
        if (Get-Marker $html) { [IO.File]::WriteAllText($index, [regex]::Replace($html, $BlockPattern, ''), $Utf8); $done = $true }
        Remove-Item -LiteralPath (Join-Path $folder $AssetDir) -Recurse -Force -ErrorAction SilentlyContinue
    }
    $spa = Join-Path $apps 'xpui.spa'
    $backup = $spa + $BackupSuffix
    if ((Test-Path -LiteralPath $spa) -and (Get-Marker (Read-ZipText $spa 'index.html'))) {
        if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $spa -Force }
        else { Write-PatchedSpa $spa $spa ([regex]::Replace((Read-ZipText $spa 'index.html'), $BlockPattern, '')) @{} }
        $done = $true
    }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    if ($done) { return 'RESTORED' }
    return 'NOT_PATCHED'
}

function Get-PatchStatus([string]$Dir) {
    $index = Join-Path $Dir 'Apps\xpui\index.html'
    if (Test-Path -LiteralPath $index) {
        $m = Get-Marker ([IO.File]::ReadAllText($index, $Utf8))
        if ($m) { return "dir patched v$m" } else { return 'dir not-patched' }
    }
    $spa = Join-Path $Dir 'Apps\xpui.spa'
    $m = Get-Marker (Read-ZipText $spa 'index.html')
    $b = if (Test-Path -LiteralPath ($spa + $BackupSuffix)) { ' backup' } else { '' }
    if ($m) { return "spa patched v$m$b" } else { return "spa not-patched$b" }
}

# -------------------------------------------------------------- process ---
function Test-SpotifyRunning { [bool](Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue) }

function Stop-Spotify {
    for ($i = 0; $i -lt 10; $i++) {
        $procs = Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue
        if (-not $procs) { return }
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Warn '无法结束 Spotify 进程'
}

# --------------------------------------------------------------- direct ---
# Spotify's renderer enforces CORS and NetEase / QQ send no CORS headers, so the
# plugin reaches them itself only when Spotify runs with --disable-web-security.
# Opt-in (-Direct): the switch is added to the Spotify shortcuts and to Spotify's
# own autostart entry. Without it the lyrics server relays the requests.
$DirectFlag = '--disable-web-security'
$DirectMarker = Join-Path $DataDir 'direct'
function Test-DirectMode { Test-Path -LiteralPath $DirectMarker }

function Get-SpotifyShortcuts {
    $paths = @()
    if ($env:APPDATA) { $paths += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Spotify.lnk') }
    try { $paths += (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Spotify.lnk') } catch { }
    return @($paths | Where-Object { Test-Path -LiteralPath $_ })
}

function Set-DirectMode([bool]$Enable) {
    if (-not $OnWindows) { return }
    $flag = [regex]::Escape($DirectFlag)
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in Get-SpotifyShortcuts) {
        try {
            $link = $shell.CreateShortcut($path)
            $arguments = (($link.Arguments -replace $flag, '') -replace '\s+', ' ').Trim()
            if ($Enable) { $arguments = ($arguments + ' ' + $DirectFlag).Trim() }
            $link.Arguments = $arguments
            $link.Save()
        }
        catch { Warn "无法修改快捷方式 $path：$($_.Exception.Message)" }
    }
    $autostart = Get-ItemProperty -Path $RunKey -Name 'Spotify' -ErrorAction SilentlyContinue
    if ($autostart -and $autostart.Spotify) {
        $value = (($autostart.Spotify -replace (' ?' + $flag), '')).TrimEnd()
        if ($Enable) { $value = "$value $DirectFlag" }
        Set-ItemProperty -Path $RunKey -Name 'Spotify' -Value $value
    }
    if ($Enable) {
        $null = New-Item -ItemType Directory -Force -Path $DataDir
        Set-Content -LiteralPath $DirectMarker -Value $DirectFlag -Encoding ASCII
        Say "已启用本机直连：Spotify 快捷方式和开机自启将以 $DirectFlag 启动"
        Warn '提示：该参数会关闭 Spotify 内置浏览器的同源限制，可用 patch.cmd -NoDirect 撤销；Spotify 自动更新重建快捷方式后会改用服务器转发'
    }
    else {
        Remove-Item -LiteralPath $DirectMarker -Force -ErrorAction SilentlyContinue
        Say '已取消本机直连，歌词请求将经服务器转发'
    }
}

function Start-Spotify([string]$Dir) {
    $exe = Join-Path $Dir 'Spotify.exe'
    if (Test-DirectMode) { Start-Process -FilePath $exe -ArgumentList $DirectFlag } else { Start-Process -FilePath $exe }
}

# --------------------------------------------------------- server ---
function Test-Server {
    try { return (Invoke-RestMethod -Uri "$Server/health" -TimeoutSec 8 -UseBasicParsing).version } catch { return $null }
}

# Versions before 1.1 installed a local proxy (127.0.0.1:38917); lyrics now come
# from the remote lyrics server, so remove it if it is still there.
function Remove-LegacyProxy {
    if (-not $OnWindows) { return }
    $exe = Join-Path $DataDir 'spot-lyric-proxy.exe'
    $registered = Get-ItemProperty -Path $RunKey -Name 'SpotLyricProxy' -ErrorAction SilentlyContinue
    if (-not $registered -and -not (Test-Path -LiteralPath $exe)) { return }
    Get-Process -Name 'spot-lyric-proxy' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKey -Name 'SpotLyricProxy' -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Say '已移除旧版本地歌词代理（歌词现在由歌词服务器提供）'
}

# ----------------------------------------------------------------- hook ---
function Install-Hook {
    if (-not $OnWindows) { Warn '非 Windows 环境：跳过'; return }
    $target = Join-Path $DataDir 'patcher'
    $null = New-Item -ItemType Directory -Force -Path $target
    foreach ($item in @('patch.ps1', 'VERSION', 'src')) {
        Copy-Item -LiteralPath (Join-Path $Root $item) -Destination $target -Recurse -Force
    }
    Get-ChildItem -LiteralPath $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    $script = Join-Path $target 'patch.ps1'
    $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" apply -Quiet -Server {1}' -f $script, $Server
    if (Test-DirectMode) { $cmd += ' -Direct' }
    if ($SpotifyPath) { $cmd += (' -SpotifyPath "{0}"' -f $SpotifyPath) }
    $null = New-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -Value $cmd -PropertyType String -Force
    Say '已安装登录钩子：每次登录 Windows 时检查并重新注入（Spotify 自动更新后生效）'
}

function Remove-Hook {
    if (-not $OnWindows) { return }
    Remove-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $DataDir 'patcher') -Recurse -Force -ErrorAction SilentlyContinue
    Say '已移除登录钩子'
}

# ----------------------------------------------------------------- main ---
function Invoke-Apply {
    $dir = Find-Spotify
    if (-not $dir) { Fail '没有找到 Spotify，请从 https://www.spotify.com/download 安装，或用 -SpotifyPath 指定目录' }
    Say "Spotify 安装目录：$dir"
    Say "Spotify 版本：$(Get-SpotifyVersion $dir)"
    $digest = (Get-Bundle).Digest
    $needsWrite = (Get-PatchStatus $dir) -notmatch [regex]::Escape("patched v$Version $digest")
    # Windows locks xpui.spa while Spotify runs: it has to be closed for the rewrite.
    $wasRunning = $OnWindows -and (Test-SpotifyRunning)
    if ($needsWrite -and $wasRunning) {
        if ($NoRestart) { Fail 'Spotify 正在运行，xpui.spa 被占用：请完全退出 Spotify（含托盘图标）后重试，或去掉 -NoRestart' }
        Say '关闭 Spotify 以写入补丁…'
        Stop-Spotify
    }
    try { $result = Invoke-Patch $dir }
    catch { Fail ("注入失败：{0}`n如果提示文件被占用，请完全退出 Spotify（包括托盘图标）后重试" -f $_.Exception.Message) }
    if ($result -like 'PATCHED*') { Say "已注入歌词插件 v$Version → $($result.Substring(8))" } else { Say "插件已是最新（v$Version），无需修改" }
    $directChanged = $false
    if ($Direct -or $NoDirect) {
        $directChanged = ([bool]$Direct) -ne (Test-DirectMode)
        Set-DirectMode ([bool]$Direct)
    }
    if ($OnWindows) {
        if ($wasRunning -and $needsWrite) { Say '重新启动 Spotify…'; Start-Spotify $dir }
        elseif ($Restart -or ($directChanged -and (Test-SpotifyRunning) -and -not $NoRestart)) { Stop-Spotify; Start-Spotify $dir }
        elseif (-not $wasRunning) { Say '下次启动 Spotify 时生效' }
    }
    return $dir
}

switch ($Command) {
    'install' {
        $null = Invoke-Apply
        Remove-LegacyProxy
        Say '完成！在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页。'
    }
    'apply' { $null = Invoke-Apply }
    { $_ -in 'restore', 'uninstall' } {
        $dir = Find-Spotify
        if (-not $dir) { Fail '没有找到 Spotify 安装目录' }
        $wasRunning = $OnWindows -and (Test-SpotifyRunning)
        if ($wasRunning) { Stop-Spotify }
        $result = Invoke-Restore $dir
        if ($result -eq 'RESTORED') { Say '已还原 Spotify 原始文件' } else { Say 'Spotify 未被修改，无需还原' }
        if ($Command -eq 'uninstall') { Remove-LegacyProxy; Remove-Hook; if (Test-DirectMode) { Set-DirectMode $false } }
        if ($wasRunning -and -not $NoRestart) { Start-Spotify $dir }
    }
    'status' {
        $dir = Find-Spotify
        if ($dir) {
            Write-Host "Spotify：$dir"
            Write-Host "版本：$(Get-SpotifyVersion $dir)"
            Write-Host "补丁：$(Get-PatchStatus $dir)"
        }
        else { Write-Host 'Spotify：未找到' }
        Write-Host "插件版本：v$Version"
        $v = Test-Server
        if ($v) { Write-Host "歌词服务器：运行正常 v$v · $Server" } else { Write-Host "歌词服务器：无法连接 $Server" }
        if (Test-DirectMode) { Write-Host "网易云 / QQ 请求：本机直连（$DirectFlag）" } else { Write-Host '网易云 / QQ 请求：经歌词服务器转发（-Direct 可改为本机直连）' }
        if ($OnWindows) {
            $hook = (Get-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -ErrorAction SilentlyContinue)
            if ($hook) { Write-Host '登录钩子：已安装' } else { Write-Host '登录钩子：未安装' }
        }
    }
    'hook' { Install-Hook }
    'unhook' { Remove-Hook }
}
