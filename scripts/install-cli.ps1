param([string]$InstallDir = $(if ($env:MINIQ_INSTALL_DIR) { $env:MINIQ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'miniQ\bin' }))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS/Linux.' }
$MiniqArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($MiniqArch -ne 'AMD64') { throw "Unsupported Windows architecture: $MiniqArch. miniQ terminal requires x64." }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'Windows 10/11 tar.exe is required.' }
if (-not [IO.Path]::IsPathRooted($InstallDir)) { throw 'MINIQ_INSTALL_DIR must be an absolute path.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$MiniqOrigin = 'https://oss.zaiwen.top/releases/miniq'
$MiniqMetadata = "$MiniqOrigin/terminal.json"
if ($env:MINIQ_VERSION) {
    if ($env:MINIQ_VERSION -notmatch '^\d+\.\d+\.\d+$') { throw 'MINIQ_VERSION must be x.y.z.' }
    $MiniqMetadata = "$MiniqOrigin/v$env:MINIQ_VERSION/terminal.json"
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$MiniqWork = Join-Path ([IO.Path]::GetTempPath()) ('miniq-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $MiniqWork | Out-Null
$MiniqLock = $null
$MiniqBackups = @{}
$MiniqMigrating = $false
$MiniqCommitted = $false
function Get-MiniqFile([string]$Url, [string]$Destination) {
    if (-not $Url.StartsWith('https://')) { throw 'miniQ downloads require HTTPS.' }
    # The public origin serves files directly. Refuse redirects to prevent an
    # HTTPS-to-HTTP downgrade in Windows PowerShell's web request implementation.
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 600
}
function Set-MiniqFile([string]$Source, [string]$Destination) {
    # PowerShell coerces $null to an empty string for a .NET string parameter.
    # File.Replace requires an actual null when no backup pathname is requested.
    if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source, $Destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($Source, $Destination) }
}
try {
    Write-Host 'Downloading miniQ terminal metadata...'
    Get-MiniqFile $MiniqMetadata (Join-Path $MiniqWork 'terminal.json')
    $MiniqManifest = Get-Content (Join-Path $MiniqWork 'terminal.json') -Raw | ConvertFrom-Json
    $MiniqVersion = [string]$MiniqManifest.version
    if ($MiniqVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid terminal manifest version.' }
    if ($env:MINIQ_VERSION -and $env:MINIQ_VERSION -ne $MiniqVersion) { throw 'Manifest version does not match requested version.' }
    $MiniqPlatform = $MiniqManifest.platforms.'x86_64-pc-windows-msvc'
    if ($MiniqPlatform.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid terminal checksum.' }
    $MiniqExpectedUrl = "$MiniqOrigin/v$MiniqVersion/miniQ_terminal_${MiniqVersion}_x86_64-pc-windows-msvc.tar.gz"
    if ($MiniqPlatform.url -ne $MiniqExpectedUrl) { throw 'Invalid terminal archive URL.' }
    $MiniqArchive = Join-Path $MiniqWork 'archive.tar.gz'
    Get-MiniqFile $MiniqPlatform.url $MiniqArchive
    if ((Get-FileHash $MiniqArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $MiniqPlatform.sha256) {
        throw 'Archive checksum mismatch; existing installation was not changed.'
    }
    $MiniqEntries = & tar.exe -tzf $MiniqArchive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect terminal archive.' }
    foreach ($MiniqEntry in $MiniqEntries) {
        if ($MiniqEntry -notmatch '^(\./)?(miniq\.exe|miniq-daemon\.exe|miniq-launcher\.exe|README\.md)?$' -and $MiniqEntry -ne './') {
            throw "Unexpected archive entry: $MiniqEntry"
        }
    }
    $MiniqPayload = Join-Path $MiniqWork 'payload'
    New-Item -ItemType Directory $MiniqPayload | Out-Null
    & tar.exe -xzf $MiniqArchive -C $MiniqPayload
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract terminal archive.' }
    foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe', 'miniq-launcher.exe')) {
        $MiniqFile = Get-Item (Join-Path $MiniqPayload $MiniqProgram)
        if ($MiniqFile.PSIsContainer -or ($MiniqFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid executable: $MiniqProgram" }
    }
    $MiniqReportedVersion = & (Join-Path $MiniqPayload 'miniq.exe') --version
    if ($LASTEXITCODE -ne 0 -or $MiniqReportedVersion -ne "miniq $MiniqVersion") { throw 'Downloaded executable version does not match the manifest.' }
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    try { $MiniqLock = [IO.File]::Open((Join-Path $InstallDir '.miniq-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another installer is running. Retry when it finishes.' }
    $MiniqStore = Join-Path $InstallDir '.miniq'
    $MiniqMarker = Join-Path $MiniqStore 'managed'
    $MiniqManaged = Test-Path $MiniqMarker
    if ($MiniqManaged -and (Get-Content $MiniqMarker -Raw).Trim() -ne 'miniq-terminal-v1') { throw 'Unknown installer layout.' }
    $MiniqRelease = Join-Path $MiniqStore "versions\$MiniqVersion"
    New-Item -ItemType Directory -Force (Split-Path $MiniqRelease) | Out-Null
    if (Test-Path $MiniqRelease) {
        foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe')) {
            if ((Get-FileHash (Join-Path $MiniqRelease $MiniqProgram)).Hash -ne (Get-FileHash (Join-Path $MiniqPayload $MiniqProgram)).Hash) {
                throw "Existing version $MiniqVersion differs; refusing to overwrite it."
            }
        }
    } else {
        $MiniqStage = Join-Path (Split-Path $MiniqRelease) ('.stage-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $MiniqStage | Out-Null
        Copy-Item (Join-Path $MiniqPayload 'miniq.exe'), (Join-Path $MiniqPayload 'miniq-daemon.exe') $MiniqStage
        Move-Item $MiniqStage $MiniqRelease
    }
    # Stable native launchers remain untouched during updates, even while busy.
    # They resolve a single atomic version pointer and preserve all CLI arguments.
    if (-not $MiniqManaged) {
        foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe')) {
            $MiniqDestination = Join-Path $InstallDir $MiniqProgram
            if (Test-Path $MiniqDestination) {
                if ((Get-Item $MiniqDestination).PSIsContainer) { throw "Cannot replace directory: $MiniqDestination" }
                # Verify both legacy executables can be replaced before changing
                # either one. A running daemon remains untouched and fails here.
                $MiniqProbe = [IO.File]::Open($MiniqDestination, 'Open', 'ReadWrite', 'None')
                $MiniqProbe.Dispose()
                $MiniqBackup = Join-Path $MiniqWork "restore-$MiniqProgram"
                Copy-Item $MiniqDestination $MiniqBackup
                $MiniqBackups[$MiniqProgram] = $MiniqBackup
            } else { $MiniqBackups[$MiniqProgram] = $null }
        }
        $MiniqMigrating = $true
        foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe')) {
            $MiniqDestination = Join-Path $InstallDir $MiniqProgram
            $MiniqStage = Join-Path $InstallDir ('.launcher-' + [guid]::NewGuid().ToString('N'))
            Copy-Item (Join-Path $MiniqPayload 'miniq-launcher.exe') $MiniqStage
            try { Set-MiniqFile $MiniqStage $MiniqDestination }
            catch { Remove-Item -Force $MiniqStage; throw "Cannot replace legacy $MiniqProgram while in use. No process was stopped; exit that terminal and retry. $_" }
        }
    }
    $MiniqPointer = Join-Path $MiniqStore ('current-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($MiniqPointer, "$MiniqVersion`n", [Text.UTF8Encoding]::new($false))
    Set-MiniqFile $MiniqPointer (Join-Path $MiniqStore 'current-version')
    [IO.File]::WriteAllText($MiniqMarker, "miniq-terminal-v1`n", [Text.UTF8Encoding]::new($false))
    $MiniqCommitted = $true
    if ($env:MINIQ_NO_MODIFY_PATH -ne '1') {
        $MiniqUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $MiniqPaths = @($MiniqUserPath -split ';' | Where-Object { $_ })
        if ($MiniqPaths -notcontains $InstallDir) { [Environment]::SetEnvironmentVariable('Path', (@($InstallDir) + $MiniqPaths -join ';'), 'User') }
        if (@($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$InstallDir;$env:Path" }
    }
    Write-Host "miniQ $MiniqVersion installed in $InstallDir. Run: miniq"
    Write-Host 'Update later with: miniq update. Existing tasks keep running; the new daemon starts after the current daemon exits safely.'
} finally {
    if ($MiniqMigrating -and -not $MiniqCommitted) {
        foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe')) {
            $MiniqDestination = Join-Path $InstallDir $MiniqProgram
            if ($MiniqBackups[$MiniqProgram]) {
                $MiniqRestore = Join-Path $InstallDir ('.restore-' + [guid]::NewGuid().ToString('N'))
                Copy-Item $MiniqBackups[$MiniqProgram] $MiniqRestore
                Set-MiniqFile $MiniqRestore $MiniqDestination
            } elseif (Test-Path $MiniqDestination) { Remove-Item -Force $MiniqDestination }
        }
    }
    if ($MiniqLock) { $MiniqLock.Dispose() }
    Remove-Item -Recurse -Force $MiniqWork
}
