#Requires -Version 5.1
<#
.SYNOPSIS
  Spot-Lyric for Spotify (Windows) - injects the third-party lyrics page into the Spotify desktop client.
  macOS / Linux: patch.sh - same commands, options and guided steps.

.DESCRIPTION
  Usage modes (asked step by step, or --mode):
    cloud   lyrics server stores shared matches (default); NetEase / QQ requests (--request)
            go direct (--disable-web-security) or through the lyrics server relay
    local   pure local: the local service (spot-lyric-server on 127.0.0.1:38917,
            downloaded / built only for this mode) relays NetEase / QQ requests
    direct  pure local without the service: --disable-web-security (advanced)
  The plugin always prefers local paths: direct -> local service -> lyrics server.

.EXAMPLE
  .\patch.cmd                      # guided install
  .\patch.cmd --mode local -y      # pure local with the local service, no questions
  .\patch.cmd status
  .\patch.cmd --help
#>
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Repo = 'dibin666/spotify-patch-lryic'
$Root = $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Version = ([IO.File]::ReadAllText((Join-Path $Root 'VERSION'), $Utf8)).Trim()
$DefaultServer = 'https://spo.564616.xyz'
$LocalUrl = 'http://127.0.0.1:38917'
$ServerPattern = '^https?://[A-Za-z0-9._~:/-]+$'
# PowerShell 5.1 only exists on Windows; pwsh exposes $IsWindows. Non-Windows runs are for testing.
$OnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$DataDir = if ($env:SPOT_LYRIC_DATA) { $env:SPOT_LYRIC_DATA } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'SpotLyric' } else { Join-Path $HOME '.spot-lyric-test' }
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AssetDir = 'spot-lyric'
$BackupSuffix = '.spot-lyric.bak'
$BlockPattern = '(?s)<!-- spot-lyric:start[^>]*-->.*?<!-- spot-lyric:end -->'
$MarkerPattern = '<!-- spot-lyric:start v(\S+) sha=(\w+) -->'

$Script:Quiet = $false
function Say([string]$Text) { if (-not $Script:Quiet) { Write-Host "[spot-lyric] $Text" -ForegroundColor Green } }
function Warn([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "[spot-lyric] $Text" -ForegroundColor Red; exit 1 }
function Request-Name([string]$R) { switch ($R) { 'service' { '本地服务' } 'direct' { '直连' } 'server' { '经歌词服务器转发' } } }
function Mode-Name([string]$Mode) { switch ($Mode) { 'cloud' { '云端服务器' } 'local' { '纯本地 · 本地服务' } 'direct' { '纯本地 · 直连' } } }

function Show-Usage {
    @"
Spot-Lyric for Spotify v$Version（Windows；macOS / Linux 运行 ./patch.sh，命令和参数相同）

用法: patch.cmd [命令] [选项]

命令:
  install      安装 / 更新（默认）：分步选择使用方式，注入插件并完成相应设置
  apply        只注入插件（沿用上次选择的使用方式）
  status       查看 Spotify、补丁、使用方式和服务状态
  restore      还原 Spotify 原始文件
  uninstall    还原 Spotify，并移除钩子、本地服务和直连启动参数
  hook         安装自动重新注入（每次登录 Windows 时检查）
  unhook       移除自动重新注入

使用方式（--mode）:
  cloud        云端服务器（默认）：服务器保存共享的匹配与歌词；网易云 / QQ 请求见 --request
  local        纯本地：不连接远程服务器，请求经本机 127.0.0.1:38917 的本地服务
               （spot-lyric-server，仅此方式需要下载 / 编译）
  direct       纯本地，不用本地服务而以 --disable-web-security 启动 Spotify（高级）

云端模式下网易云 / QQ 的请求方式（--request；插件始终本地优先：直连 → 本地服务 → 歌词服务器）:
  direct       直连：以 --disable-web-security 启动 Spotify，请求从本机发出
  server       经歌词服务器原样转发

选项:
  --mode M             使用方式：cloud / local / direct（不指定时分步询问）
  --request R          云端模式的网易云 / QQ 请求方式：direct / server（不指定时分步询问）
  --server URL         歌词服务器地址（默认 $DefaultServer）
  --local / --direct   等同 --mode local / --mode direct
  --spotify-path P     手动指定 Spotify 安装目录
  --hook / --no-hook   安装 / 不安装自动重新注入
  --restart            完成后总是重启 Spotify
  --no-restart         不重启 Spotify
  -y, --yes            不询问，使用参数、上次的选择或默认值
  -q, --quiet          安静模式
  -h, --help           显示帮助
"@
}

# -------------------------------------------------------------- options ---
# Long options may be written --name, -name or PowerShell style (-Server, -NoRestart).
$Command = ''; $Mode = ''; $Request = ''; $Server = ''; $SpotifyPath = ''; $RestartPolicy = 'auto'; $Hook = ''; $Yes = $false
$argv = @($args)
for ($i = 0; $i -lt $argv.Count; $i++) {
    $arg = [string]$argv[$i]
    if (-not $arg.StartsWith('-')) {
        if ($Command) { Show-Usage; Fail "多余的参数：$arg" }
        switch ($arg.ToLower()) {
            { $_ -in 'install', 'apply', 'restore', 'uninstall', 'status', 'hook', 'unhook' } { $Command = $_ }
            'help' { Show-Usage; exit 0 }
            'version' { Write-Output $Version; exit 0 }
            default { Show-Usage; Fail "未知命令：$arg" }
        }
        continue
    }
    $name = $arg.TrimStart('-'); $value = $null
    if ($name.Contains('=')) { $value = $name.Substring($name.IndexOf('=') + 1); $name = $name.Substring(0, $name.IndexOf('=')) }
    $key = $name.ToLower().Replace('-', '').Replace('_', '')
    $take = {
        if ($null -ne $value) { return $value }
        if ($script:i + 1 -ge $argv.Count) { Fail "$arg 需要一个值" }
        $script:i++
        return [string]$argv[$script:i]
    }
    switch ($key) {
        'mode' {
            $v = (& $take).ToLower()
            switch ($v) {
                { $_ -in 'cloud', 'server', 'remote' } { $Mode = 'cloud' }
                { $_ -in 'local', 'service' } { $Mode = 'local' }
                'direct' { $Mode = 'direct' }
                default { Fail "未知的使用方式：$v（cloud / local / direct）" }
            }
        }
        'request' {
            $v = (& $take).ToLower()
            switch ($v) {
                { $_ -in 'service', 'local' } { $Request = 'service' }
                'direct' { $Request = 'direct' }
                { $_ -in 'server', 'relay', 'remote', 'none' } { $Request = 'server' }
                default { Fail "未知的请求方式：$v（service / direct / server）" }
            }
        }
        'server' {
            $Server = (& $take).Trim().TrimEnd('/')
            if ($Server -notmatch $ServerPattern) { Fail "歌词服务器地址无效：$Server（例如 https://lyrics.example.com）" }
        }
        'spotifypath' { $SpotifyPath = & $take }
        'cloud' { $Mode = 'cloud' }
        'nodirect' { $Request = 'server' }
        'local' { $Mode = 'local' }
        'direct' { $Mode = 'direct' }
        'restart' { $RestartPolicy = 'yes' }
        'norestart' { $RestartPolicy = 'no' }
        'hook' { $Hook = 'on' }
        'nohook' { $Hook = 'off' }
        { $_ -in 'yes', 'y' } { $Yes = $true }
        { $_ -in 'quiet', 'q' } { $Script:Quiet = $true }
        { $_ -in 'help', 'h' } { Show-Usage; exit 0 }
        default { Show-Usage; Fail "未知参数：$arg" }
    }
}
if (-not $Command) { $Command = 'install' }
# --request is the cloud mode's choice; "service" means the pure local mode.
if ($Request -eq 'service') {
    if ($Mode -eq 'cloud') { Fail '本地服务只用于纯本地模式（--mode local）；云端模式的 --request 可选 direct / server' }
    $Mode = 'local'; $Request = ''
}
if ($Mode -eq 'local' -and $Request) { Fail '纯本地模式（--mode local）使用本地服务，不需要 --request' }
if ($Mode -eq 'direct' -and $Request -eq 'server') { Fail '--mode direct 是不连接服务器的纯本地模式，不能配合 --request server' }
if ($Mode -eq 'direct') { $Request = '' }

# --------------------------------------------------------------- config ---
$ConfigFile = Join-Path $DataDir 'config'
$CfgMode = ''; $CfgServer = ''; $CfgRequest = ''
if (Test-Path -LiteralPath $ConfigFile) {
    foreach ($line in [IO.File]::ReadAllLines($ConfigFile, $Utf8)) {
        if ($line -match '^mode=(cloud|local|direct)$') { $CfgMode = $Matches[1] }
        if ($line -match '^request=(service|direct|server)$') { $CfgRequest = $Matches[1] }
        if ($line -match '^server=(.+)$' -and $Matches[1] -match $ServerPattern) { $CfgServer = $Matches[1] }
    }
}
function Save-Config([string]$M, [string]$S, [string]$R) {
    $null = New-Item -ItemType Directory -Force -Path $DataDir
    $text = "mode=$M`nrequest=$R`n"
    if ($S -ne $DefaultServer) { $text += "server=$S`n" }
    [IO.File]::WriteAllText($ConfigFile, $text, $Utf8)
}

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
# The usage mode and both addresses are baked into the plugin.
function Get-Bundle([string]$M, [string]$S, [string]$R) {
    $core = [IO.File]::ReadAllText((Join-Path $Root 'src\core.js'), $Utf8)
    $app = [IO.File]::ReadAllText((Join-Path $Root 'src\app.js'), $Utf8)
    $app = $app.Replace('__SPOT_LYRIC_VERSION__', $Version).Replace('__SPOT_LYRIC_SERVER__', $S).Replace('__SPOT_LYRIC_MODE__', $M).Replace('__SPOT_LYRIC_REQUEST__', $R).Replace('__SPOT_LYRIC_LOCAL__', $LocalUrl)
    $js = "/* Spot-Lyric for Spotify v$Version - generated, do not edit */`n" + $core + "`n" + $app
    $css = [IO.File]::ReadAllText((Join-Path $Root 'src\app.css'), $Utf8)
    $jsBytes = $Utf8.GetBytes($js)
    $cssBytes = $Utf8.GetBytes($css)
    # Same digest as patch.sh: sha256(js + "\0" + css)[:16]
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
function Invoke-Patch([string]$Dir, $Bundle) {
    $assets = [ordered]@{ 'spot-lyric.js' = $Bundle.Js; 'spot-lyric.css' = $Bundle.Css }
    $wanted = "$Version $($Bundle.Digest)"
    $apps = Join-Path $Dir 'Apps'
    $folder = Join-Path $apps 'xpui'
    $index = Join-Path $folder 'index.html'
    if (Test-Path -LiteralPath $index -PathType Leaf) {
        # Extracted xpui directory (e.g. after spicetify / SpotX developer mode)
        $html = [IO.File]::ReadAllText($index, $Utf8)
        if ((Get-Marker $html) -eq $wanted) { return 'UNCHANGED' }
        $null = New-Item -ItemType Directory -Force -Path (Join-Path $folder $AssetDir)
        foreach ($name in $assets.Keys) { [IO.File]::WriteAllBytes((Join-Path (Join-Path $folder $AssetDir) $name), $assets[$name]) }
        [IO.File]::WriteAllText($index, (Add-Injection $html $Bundle.Digest), $Utf8)
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
    Write-PatchedSpa $backup $spa (Add-Injection $html $Bundle.Digest) $assets
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

function Describe-Patch([string]$Status) {
    if ($Status -match 'not-patched') { return '未注入' }
    if ($Status -match 'patched v(\S+)') { return "已注入 v$($Matches[1])" }
    return $Status
}

# -------------------------------------------------------------- process ---
function Test-SpotifyRunning { [bool](Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue) }

function Stop-Spotify {
    for ($n = 0; $n -lt 10; $n++) {
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
# The switch is added to the Spotify shortcuts and to Spotify's own autostart entry.
$DirectFlag = '--disable-web-security'
# Newer Chromium refuses --disable-web-security unless --user-data-dir is a non-default path.
$DirectProfile = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [IO.Path]::GetTempPath() }) 'Spotify\DirectProfile'
$DirectArgs = "$DirectFlag --user-data-dir=`"$DirectProfile`""
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
    $flag = '(?:' + [regex]::Escape($DirectFlag) + '|--user-data-dir="[^"]*DirectProfile")'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in Get-SpotifyShortcuts) {
        try {
            $link = $shell.CreateShortcut($path)
            $arguments = (($link.Arguments -replace $flag, '') -replace '\s+', ' ').Trim()
            if ($Enable) { $arguments = ($arguments + ' ' + $DirectArgs).Trim() }
            $link.Arguments = $arguments
            $link.Save()
        }
        catch { Warn "无法修改快捷方式 $path：$($_.Exception.Message)" }
    }
    $autostart = Get-ItemProperty -Path $RunKey -Name 'Spotify' -ErrorAction SilentlyContinue
    if ($autostart -and $autostart.Spotify) {
        $value = (($autostart.Spotify -replace (' ?' + $flag), '')).TrimEnd()
        if ($Enable) { $value = "$value $DirectArgs" }
        Set-ItemProperty -Path $RunKey -Name 'Spotify' -Value $value
    }
    if ($Enable) {
        $null = New-Item -ItemType Directory -Force -Path $DataDir
        Set-Content -LiteralPath $DirectMarker -Value $DirectFlag -Encoding ASCII
        Say "已启用直连：Spotify 快捷方式和开机自启将以 $DirectArgs 启动"
        Warn '直连使用单独的配置目录，首次启动可能需要重新登录 Spotify；Spotify 更新重建快捷方式后请重新运行本脚本'
    }
    else {
        Remove-Item -LiteralPath $DirectMarker -Force -ErrorAction SilentlyContinue
        Say '已取消直连启动参数'
    }
}

function Start-Spotify([string]$Dir) {
    $exe = Join-Path $Dir 'Spotify.exe'
    if (Test-DirectMode) { Start-Process -FilePath $exe -ArgumentList $DirectArgs } else { Start-Process -FilePath $exe }
}

# ------------------------------------------------------- hidden launcher ---
# Run entries would flash a console window; wscript starts them hidden.
$HiddenVbs = Join-Path $DataDir 'hidden.vbs'
function Write-HiddenLauncher {
    $null = New-Item -ItemType Directory -Force -Path $DataDir
    $vbs = @(
        "' Spot-Lyric: runs a program without a console window.",
        'Dim i, a, cmd',
        'For i = 0 To WScript.Arguments.Count - 1',
        '  a = WScript.Arguments(i)',
        '  If InStr(a, " ") > 0 Then a = """" & a & """"',
        '  cmd = cmd & a & " "',
        'Next',
        'CreateObject("WScript.Shell").Run cmd, 0, False'
    ) -join "`r`n"
    [IO.File]::WriteAllText($HiddenVbs, $vbs + "`r`n", [Text.Encoding]::ASCII)
}
function Get-HiddenCommand([string[]]$Parts) {
    $quoted = $Parts | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
    return "wscript.exe //B //Nologo `"$HiddenVbs`" " + ($quoted -join ' ')
}

# -------------------------------------------------------- local service ---
# spot-lyric-server serve --local on 127.0.0.1:38917, only for --mode local. Built from
# this checkout when Go is installed, otherwise the release binary of this version.
$ServiceExe = Join-Path $DataDir 'spot-lyric-server.exe'
$ServiceRun = 'SpotLyricLocal'
function Test-ServiceInstalled { $OnWindows -and [bool](Get-ItemProperty -Path $RunKey -Name $ServiceRun -ErrorAction SilentlyContinue) }
function Get-LocalHealth {
    try { $h = Invoke-RestMethod -Uri "$LocalUrl/health" -TimeoutSec 2 -UseBasicParsing; if ($h.ok) { return $h.version } } catch { }
    return $null
}
function Stop-LocalService {
    Get-CimInstance Win32_Process -Filter "Name='spot-lyric-server.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($DataDir, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
}
function Get-LocalServer {
    if ((Test-Path -LiteralPath $ServiceExe) -and $env:SPOT_LYRIC_BUILD -ne '1') {
        try { if ((& $ServiceExe version) -eq $Version) { return } } catch { }
    }
    $null = New-Item -ItemType Directory -Force -Path $DataDir
    Stop-LocalService
    if ((Test-Path -LiteralPath (Join-Path $Root 'go.mod')) -and $env:SPOT_LYRIC_BUILD -ne '0' -and (Get-Command go -ErrorAction SilentlyContinue)) {
        Say '从源码编译本地服务（Go）…'
        Push-Location $Root
        try {
            $env:CGO_ENABLED = '0'
            & go build -trimpath -ldflags '-s -w' -o "$ServiceExe.new" ./cmd/spot-lyric-server
            if ($LASTEXITCODE -eq 0) { Move-Item -LiteralPath "$ServiceExe.new" -Destination $ServiceExe -Force; return }
            Warn '编译失败，改为下载预编译程序'
        }
        finally { Pop-Location }
    }
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $asset = if ($arch -eq 'ARM64') { 'spot-lyric-server-windows-arm64.exe' } else { 'spot-lyric-server-windows-amd64.exe' }
    foreach ($tag in @("v$Version", 'latest')) {
        $base = if ($tag -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$tag" }
        Say "下载本地服务 $asset（$tag）…"
        try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile "$ServiceExe.new" } catch { continue }
        try {
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
            if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
            $line = $sums -split "`n" | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($asset) + '\s*$') } | Select-Object -First 1
            if ($line -and (($line -split '\s+')[0].ToLower() -ne (Get-FileHash -Algorithm SHA256 -LiteralPath "$ServiceExe.new").Hash.ToLower())) {
                Remove-Item -LiteralPath "$ServiceExe.new" -Force
                Fail "$asset 校验失败（SHA256 不一致）"
            }
        }
        catch [System.Net.WebException] { }
        Unblock-File -LiteralPath "$ServiceExe.new" -ErrorAction SilentlyContinue
        Move-Item -LiteralPath "$ServiceExe.new" -Destination $ServiceExe -Force
        return
    }
    Fail "无法下载本地服务（https://github.com/$Repo/releases）。可安装 Go 后在仓库目录中重新运行以从源码编译，或改用其它使用方式。"
}
function Install-LocalService {
    if (-not $OnWindows) { Warn '非 Windows 环境：跳过本地服务'; return }
    Get-LocalServer
    Write-HiddenLauncher
    $cmd = Get-HiddenCommand @($ServiceExe, 'serve', '--local', '--data', $DataDir)
    $null = New-ItemProperty -Path $RunKey -Name $ServiceRun -Value $cmd -PropertyType String -Force
    Stop-LocalService
    Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', "`"$HiddenVbs`"", "`"$ServiceExe`"", 'serve', '--local', '--data', "`"$DataDir`"") -WindowStyle Hidden
    Say "已注册登录启动项 $ServiceRun（登录时自动启动本地服务）"
    for ($n = 0; $n -lt 50; $n++) {
        $v = Get-LocalHealth
        if ($v) { Say "本地服务运行中：$LocalUrl（v$v）"; return }
        Start-Sleep -Milliseconds 200
    }
    Fail "本地服务没有在 $LocalUrl 上响应（端口 38917 可能被其它程序占用），日志：$(Join-Path $DataDir 'local.log')"
}
function Remove-LocalService {
    if (-not $OnWindows -or -not (Test-ServiceInstalled)) { return }
    Remove-ItemProperty -Path $RunKey -Name $ServiceRun -ErrorAction SilentlyContinue
    Stop-LocalService
    Say '已停止并移除本地服务'
}

# --------------------------------------------------------- legacy proxy ---
# Versions before 1.1 installed a local proxy (spot-lyric-proxy, 127.0.0.1:38917):
# removed so the port is free for the local service.
function Remove-LegacyProxy {
    if (-not $OnWindows) { return }
    $exe = Join-Path $DataDir 'spot-lyric-proxy.exe'
    $registered = Get-ItemProperty -Path $RunKey -Name 'SpotLyricProxy' -ErrorAction SilentlyContinue
    if (-not $registered -and -not (Test-Path -LiteralPath $exe)) { return }
    Get-Process -Name 'spot-lyric-proxy' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKey -Name 'SpotLyricProxy' -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Say '已移除旧版本地歌词代理（spot-lyric-proxy）'
}

# ----------------------------------------------------------------- hook ---
function Test-HookInstalled { $OnWindows -and [bool](Get-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -ErrorAction SilentlyContinue) }
function Install-Hook([string]$M, [string]$S, [string]$R, [string]$Dir) {
    if (-not $OnWindows) { Warn '非 Windows 环境：跳过'; return }
    $target = Join-Path $DataDir 'patcher'
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    $null = New-Item -ItemType Directory -Force -Path $target
    foreach ($item in @('patch.ps1', 'VERSION', 'src')) {
        Copy-Item -LiteralPath (Join-Path $Root $item) -Destination $target -Recurse -Force
    }
    Get-ChildItem -LiteralPath $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    Write-HiddenLauncher
    $cmd = Get-HiddenCommand @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $target 'patch.ps1'),
        'apply', '--yes', '--quiet', '--mode', $M, '--request', $R, '--server', $S, '--spotify-path', $Dir)
    $null = New-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -Value $cmd -PropertyType String -Force
    Say '已安装登录钩子：每次登录 Windows 时检查并重新注入（Spotify 自动更新后生效）'
}

function Remove-Hook {
    if (-not $OnWindows) { return }
    if (Test-HookInstalled) { Remove-ItemProperty -Path $RunKey -Name 'SpotLyricReapply' -ErrorAction SilentlyContinue; Say '已移除登录钩子' }
    Remove-Item -LiteralPath (Join-Path $DataDir 'patcher') -Recurse -Force -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------- prompts ---
$Script:Interactive = (-not $Yes) -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
function Read-Answer([string]$Prompt) {
    Write-Host -NoNewline $Prompt
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { $Script:Interactive = $false; Write-Host ''; return $null }
    return $line.Trim()
}
# Items: @{ Key; Label; Hint; Off }  -> chosen key
function Select-Choice([string]$Step, [string]$Title, [string]$Default, $Items) {
    if (-not $Script:Interactive) { return $Default }
    Write-Host ''
    Write-Host -NoNewline "$Step " -ForegroundColor Cyan; Write-Host $Title
    $def = 1
    for ($n = 0; $n -lt $Items.Count; $n++) {
        $it = $Items[$n]
        if ($it.Key -eq $Default) { $def = $n + 1 }
        if ($it.Off) { Write-Host "  $($n + 1)) $($it.Label) — $($it.Off)" -ForegroundColor DarkGray; continue }
        Write-Host -NoNewline "  $($n + 1)) $($it.Label)"
        if ($it.Key -eq $Default) { Write-Host '（默认）' -ForegroundColor Green } else { Write-Host '' }
        foreach ($h in ($it.Hint -split "`n")) { if ($h) { Write-Host "     $h" -ForegroundColor DarkGray } }
    }
    while ($true) {
        $a = Read-Answer "请输入序号 [$def]: "
        if ($null -eq $a) { return $Default }
        if ($a -eq '') { $a = "$def" }
        $num = 0
        if ([int]::TryParse($a, [ref]$num) -and $num -ge 1 -and $num -le $Items.Count) {
            if ($Items[$num - 1].Off) { Write-Host "不可用：$($Items[$num - 1].Off)" -ForegroundColor Yellow; continue }
            return $Items[$num - 1].Key
        }
        Write-Host "请输入 1 到 $($Items.Count) 之间的数字" -ForegroundColor Yellow
    }
}
function Confirm-Choice([string]$Question, [bool]$Default) {
    if (-not $Script:Interactive) { return $Default }
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $a = Read-Answer "$Question $hint`: "
        if ($null -eq $a) { return $Default }
        switch ($a.ToLower()) {
            '' { return $Default }
            { $_ -in 'y', 'yes', '是', '好' } { return $true }
            { $_ -in 'n', 'no', '否', '不' } { return $false }
        }
    }
}

# ---------------------------------------------------------------- plan ---
# Mode in use when nothing was recorded. Before 1.3 there was no pure local mode
# (-Direct only sped up the cloud mode), so a direct launcher still means cloud.
function Get-CurrentMode { if ($CfgMode) { $CfgMode } else { 'cloud' } }
function Get-CurrentServer { if ($Server) { $Server } elseif ($CfgServer) { $CfgServer } else { $DefaultServer } }
# Pure local modes imply their request method. Cloud: the option, the recorded choice, or
# what is set up (shortcuts with the direct switches from 1.2 -Direct mean direct).
function Get-CurrentRequest([string]$M) {
    if ($M -eq 'local') { return 'service' }
    if ($M -eq 'direct') { return 'direct' }
    if ($Request) { return $Request }
    if ($CfgRequest -in 'direct', 'server') { return $CfgRequest }
    if (Test-DirectMode) { return 'direct' }
    return 'server'
}
$PureHint = "不连接任何远程服务器：在本机 127.0.0.1:38917 运行一个小服务（登录时自动启动）转发网易云 / QQ 请求；`n搜索、匹配、歌词下载都在本机进行，绑定的歌词只保存在本机（会下载或编译 spot-lyric-server，约 10 MB）"
$DirectHint = "以 --disable-web-security 启动 Spotify，请求从本机直接发出，不需要下载任何程序；会关闭内置浏览器的同源限制`n修改 Spotify 快捷方式和开机自启；使用单独的配置目录，首次需要重新登录 Spotify"
$ServerHint = 'Spotify 内置浏览器会拦截跨域请求，由歌词服务器原样转发（搜索和匹配仍在本机），什么都不用改'
$Script:Step = 0
function Next-Step { $Script:Step++; return "[$Script:Step]" }

function Get-Plan {
    $p = @{ Mode = $Mode; Request = ''; Server = (Get-CurrentServer); Hook = $false }
    if (-not $p.Mode -and ($Server -or $Request -eq 'server')) { $p.Mode = 'cloud' }
    $current = Get-CurrentMode
    $currentReq = Get-CurrentRequest 'cloud'
    if (-not $p.Mode) {
        $kind = Select-Choice (Next-Step) '选择使用方式' $(if ($current -eq 'cloud') { 'cloud' } else { 'pure' }) @(
            @{ Key = 'cloud'; Label = '云端服务器'; Hint = '歌词服务器保存「使用此歌词」和上传按钮提交的匹配，多台设备共享' },
            @{ Key = 'pure'; Label = '纯本地'; Hint = $PureHint })
        if ($kind -eq 'cloud') { $p.Mode = 'cloud' }
        elseif ($Request -eq 'direct' -or (-not $Request -and $current -eq 'direct')) { $p.Mode = 'direct' }   # kept only when asked for (--mode direct)
        else { $p.Mode = 'local' }
    }
    switch ($p.Mode) {
        'local' { $p.Request = 'service' }
        'direct' { $p.Request = 'direct' }
        'cloud' {
            if ($Script:Interactive -and -not $Server) {
                Write-Host ''
                $label = Next-Step
                while ($true) {
                    $a = Read-Answer "$label 歌词服务器地址（回车使用默认，也可以填自建服务器） [$($p.Server)]: "
                    if (-not $a) { break }
                    $a = $a.TrimEnd('/')
                    if ($a -match $ServerPattern) { $p.Server = $a; break }
                    Write-Host '地址无效，例如 https://lyrics.example.com' -ForegroundColor Yellow
                }
            }
            if ($Request) { $p.Request = $Request }
            else {
                $p.Request = Select-Choice (Next-Step) '网易云 / QQ 音乐的请求怎么发出？' $currentReq @(
                    @{ Key = 'direct'; Label = '直连'; Hint = $DirectHint },
                    @{ Key = 'server'; Label = '经歌词服务器转发'; Hint = $ServerHint })
            }
        }
    }
    switch ($Hook) {
        'on' { $p.Hook = $true }
        'off' { $p.Hook = $false }
        default {
            if ($Script:Interactive) {
                Write-Host ''
                Write-Host -NoNewline "$(Next-Step) " -ForegroundColor Cyan; Write-Host 'Spotify 自动更新后重新注入插件？（每次登录 Windows 时检查）'
                $p.Hook = Confirm-Choice '安装自动重新注入' $true
            }
            else { $p.Hook = Test-HookInstalled }
        }
    }
    if ($Script:Interactive) {
        Write-Host ''
        Write-Host '即将执行：'
        Write-Host "  • 注入歌词插件 v$Version（使用方式：$(Mode-Name $p.Mode)）"
        if ($p.Mode -eq 'cloud') { Write-Host "  • 歌词服务器：$($p.Server)" }
        if ($p.Mode -eq 'cloud') { Write-Host "  • 网易云 / QQ 请求：$(Request-Name $p.Request)" }
        switch ($p.Request) {
            'service' { Write-Host "  • 安装本地服务：$LocalUrl，登录时自动启动（需要时下载 / 编译 spot-lyric-server）" }
            'direct' { Write-Host "  • 让 Spotify 以 $DirectFlag 启动" }
        }
        if ($p.Request -ne 'direct' -and (Test-DirectMode)) { Write-Host "  • 取消 Spotify 的直连启动参数（$DirectFlag）" }
        if ($p.Request -ne 'service' -and (Test-ServiceInstalled)) { Write-Host '  • 停止并移除本地服务' }
        if ($p.Hook) { Write-Host '  • 安装自动重新注入' } elseif (Test-HookInstalled) { Write-Host '  • 移除自动重新注入' }
        Write-Host ''
        if (-not (Confirm-Choice '继续' $true)) { Fail '已取消，没有做任何修改' }
        Write-Host ''
    }
    return $p
}

# ----------------------------------------------------------------- main ---
function Get-SpotifyDir {
    $dir = Find-Spotify
    if (-not $dir) { Fail '没有找到 Spotify，请从 https://www.spotify.com/download 安装，或用 --spotify-path 指定目录' }
    return $dir
}

# Patches for mode / server. Returns @{ Changed; Stopped } (Spotify closed to write: Windows locks xpui.spa).
function Invoke-Apply([string]$Dir, [string]$M, [string]$S, [string]$R) {
    $bundle = Get-Bundle $M $S $R
    $needsWrite = (Get-PatchStatus $Dir) -notmatch [regex]::Escape("patched v$Version $($bundle.Digest)")
    $stopped = $false
    if ($needsWrite -and $OnWindows -and (Test-SpotifyRunning)) {
        if ($RestartPolicy -eq 'no') { Fail 'Spotify 正在运行，xpui.spa 被占用：请完全退出 Spotify（含托盘图标）后重试，或去掉 --no-restart' }
        Say '关闭 Spotify 以写入补丁…'
        Stop-Spotify
        $stopped = $true
    }
    try { $result = Invoke-Patch $Dir $bundle }
    catch {
        if ($stopped) { Start-Spotify $Dir }
        Fail ("注入失败：{0}`n如果提示文件被占用，请完全退出 Spotify（包括托盘图标）后重试；安装在 Program Files 时请以管理员身份运行" -f $_.Exception.Message)
    }
    if ($result -like 'PATCHED*') { Say "已注入歌词插件 v$Version（$(Mode-Name $M)）→ $($result.Substring(8))"; return @{ Changed = $true; Stopped = $stopped } }
    Say "插件已是最新（v$Version，$(Mode-Name $M)），无需修改"
    return @{ Changed = $false; Stopped = $stopped }
}

function Invoke-Restart([string]$Dir, [bool]$Changed, [bool]$Stopped) {
    if (-not $OnWindows) { return }
    if ($RestartPolicy -eq 'no') { if ($Changed) { Say '下次启动 Spotify 时生效' }; return }
    if (Test-SpotifyRunning) {
        if ($RestartPolicy -eq 'yes' -or $Changed) { Say '重启 Spotify 以加载插件…'; Stop-Spotify; Start-Spotify $Dir }
        return
    }
    if ($Stopped -or $RestartPolicy -eq 'yes') { Say '启动 Spotify…'; Start-Spotify $Dir }
    elseif ($Changed) { Say '下次启动 Spotify 时生效' }
}

switch ($Command) {
    'install' {
        if (-not $Script:Quiet) { Write-Host "Spot-Lyric for Spotify v$Version"; Write-Host "系统：Windows（$env:PROCESSOR_ARCHITECTURE）" }
        $dir = Get-SpotifyDir
        if (-not $Script:Quiet) {
            Write-Host "Spotify：$dir"; Write-Host "版本：$(Get-SpotifyVersion $dir)"; Write-Host "补丁：$(Describe-Patch (Get-PatchStatus $dir))"
        }
        $plan = Get-Plan
        Remove-LegacyProxy
        $r = Invoke-Apply $dir $plan.Mode $plan.Server $plan.Request
        $changed = $r.Changed
        switch ($plan.Request) {
            'service' { if (Test-DirectMode) { Set-DirectMode $false; $changed = $true }; Install-LocalService }
            'direct' { Remove-LocalService; if (-not (Test-DirectMode)) { $changed = $true }; Set-DirectMode $true }
            'server' { Remove-LocalService; if (Test-DirectMode) { Set-DirectMode $false; $changed = $true } }
        }
        if ($plan.Hook) { Install-Hook $plan.Mode $plan.Server $plan.Request $dir } elseif (Test-HookInstalled) { Remove-Hook }
        Save-Config $plan.Mode $plan.Server $plan.Request
        Invoke-Restart $dir $changed $r.Stopped
        if ($plan.Mode -eq 'cloud') { Say '完成！在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页；旁边的小箭头可把当前歌词上传到服务器。' }
        else { Say '完成！纯本地模式：不连接任何远程服务器。在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页。' }
        if ($plan.Mode -eq 'cloud') { Say "网易云 / QQ 请求：$(Request-Name $plan.Request)。以后想更换方式，重新运行本脚本即可。" }
        else { Say '以后想更换方式，重新运行本脚本即可。' }
    }
    'apply' {
        $dir = Get-SpotifyDir
        $m = if ($Mode) { $Mode } else { Get-CurrentMode }
        $r = Invoke-Apply $dir $m (Get-CurrentServer) (Get-CurrentRequest $m)
        Invoke-Restart $dir $r.Changed $r.Stopped
    }
    { $_ -in 'restore', 'uninstall' } {
        $dir = Get-SpotifyDir
        $wasRunning = $OnWindows -and (Test-SpotifyRunning)
        if ($wasRunning) { Stop-Spotify }
        $result = Invoke-Restore $dir
        if ($result -eq 'RESTORED') { Say '已还原 Spotify 原始文件' } else { Say 'Spotify 未被修改，无需还原' }
        if ($Command -eq 'uninstall') {
            Remove-LegacyProxy; Remove-Hook; if (Test-DirectMode) { Set-DirectMode $false }; Remove-LocalService
            foreach ($f in @($ConfigFile, $ServiceExe, $HiddenVbs, (Join-Path $DataDir 'local.log'))) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
            Remove-Item -LiteralPath (Join-Path $DataDir 'data') -Recurse -Force -ErrorAction SilentlyContinue
            Say '已卸载 Spot-Lyric'
        }
        if ($wasRunning -and $RestartPolicy -ne 'no') { Start-Spotify $dir }
    }
    'status' {
        Write-Host "Spot-Lyric for Spotify v$Version"
        Write-Host "系统：Windows（$env:PROCESSOR_ARCHITECTURE）"
        $dir = Find-Spotify
        if ($dir) {
            Write-Host "Spotify：$dir"
            Write-Host "版本：$(Get-SpotifyVersion $dir)"
            Write-Host "补丁：$(Describe-Patch (Get-PatchStatus $dir))"
        }
        else { Write-Host 'Spotify：未找到' }
        Write-Host "插件版本：v$Version"
        $m = Get-CurrentMode
        Write-Host "使用方式：$(Mode-Name $m)"
        $req = Get-CurrentRequest $m
        Write-Host "网易云 / QQ 请求：$(Request-Name $req)（始终本地优先：直连 → 本地服务$(if ($m -eq 'cloud') { ' → 歌词服务器' })）"
        if ($m -eq 'cloud') {
            $s = Get-CurrentServer
            try { $v = (Invoke-RestMethod -Uri "$s/health" -TimeoutSec 8 -UseBasicParsing).version } catch { $v = $null }
            if ($v) { Write-Host "歌词服务器：运行正常 v$v · $s" } else { Write-Host "歌词服务器：无法连接 $s" }
        }
        $v = Get-LocalHealth
        if ($v) { Write-Host "本地服务：运行中 v$v · $LocalUrl" } elseif ((Test-ServiceInstalled) -or $req -eq 'service') { Write-Host "本地服务：未运行（$LocalUrl）" }
        if (Test-DirectMode) { Write-Host "直连启动参数：已启用（$DirectFlag）" } else { Write-Host '直连启动参数：未启用' }
        if (Test-HookInstalled) { Write-Host '自动重新注入：已安装' } else { Write-Host '自动重新注入：未安装' }
    }
    'hook' {
        $dir = Get-SpotifyDir
        $m = if ($Mode) { $Mode } else { Get-CurrentMode }
        Install-Hook $m (Get-CurrentServer) (Get-CurrentRequest $m) $dir
    }
    'unhook' { Remove-Hook }
}
