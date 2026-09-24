param([Parameter(Mandatory=$true)][string]$Binaries)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$MiniqFixture = Join-Path ([IO.Path]::GetTempPath()) ('miniq-installer-test-' + [guid]::NewGuid().ToString('N'))
$MiniqInstaller = Join-Path $PSScriptRoot 'install-cli.ps1'
$MiniqRoot = [IO.Path]::GetFullPath($Binaries)
$MiniqTestVersion = ((& (Join-Path $MiniqRoot 'miniq.exe') --version) -replace '^miniq ', '').Trim()
$MiniqFixtureArchive = Join-Path $MiniqFixture 'archive.tar.gz'
$MiniqArchiveSource = Join-Path $MiniqFixture 'payload'
$env:MINIQ_NO_MODIFY_PATH = '1'
$env:MINIQ_VERSION = $MiniqTestVersion
$env:MINIQ_INSTALL_DIR = Join-Path $MiniqFixture 'install with spaces'
New-Item -ItemType Directory -Force $MiniqArchiveSource | Out-Null
foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe', 'miniq-launcher.exe')) {
    Copy-Item (Join-Path $MiniqRoot $MiniqProgram) $MiniqArchiveSource
}
& tar.exe -czf $MiniqFixtureArchive -C $MiniqArchiveSource .
if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare installer fixture archive.' }
$MiniqDigest = (Get-FileHash $MiniqFixtureArchive -Algorithm SHA256).Hash.ToLowerInvariant()
function Write-FixtureManifest([string]$Digest) {
    $MiniqFixtureManifest = @{
        version = $MiniqTestVersion
        platforms = @{
            'x86_64-pc-windows-msvc' = @{
                url = "https://oss.zaiwen.top/releases/miniq/v$MiniqTestVersion/miniQ_terminal_${MiniqTestVersion}_x86_64-pc-windows-msvc.tar.gz"
                sha256 = $Digest
            }
        }
    }
    $MiniqFixtureManifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $MiniqFixture 'terminal.json')
}
# Intercept only downloads in this test process. No production service is called.
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $MaximumRedirection, $TimeoutSec)
    if ($Uri -like '*/terminal.json') { Copy-Item (Join-Path $MiniqFixture 'terminal.json') $OutFile }
    elseif ($Uri -like '*.tar.gz') { Copy-Item $MiniqFixtureArchive $OutFile }
    else { throw "Unexpected URL: $Uri" }
}
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
    Write-FixtureManifest $MiniqDigest
    & $MiniqInstaller
    Assert-True ((& (Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe') --version) -eq "miniq $MiniqTestVersion") 'Launcher did not execute installed CLI.'
    Assert-True ((& (Join-Path $env:MINIQ_INSTALL_DIR 'miniq-daemon.exe') --version) -eq "miniq-daemon $MiniqTestVersion") 'Launcher did not execute matching daemon.'
    $MiniqHidden = [Diagnostics.ProcessStartInfo]::new()
    $MiniqHidden.FileName = Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe'
    $MiniqHidden.Arguments = '--version'
    $MiniqHidden.CreateNoWindow = $true
    $MiniqHidden.UseShellExecute = $false
    $MiniqHidden.RedirectStandardOutput = $true
    $MiniqHidden.RedirectStandardError = $true
    $MiniqProcess = [Diagnostics.Process]::Start($MiniqHidden)
    $MiniqHiddenOutput = $MiniqProcess.StandardOutput.ReadToEnd()
    $MiniqProcess.WaitForExit()
    Assert-True ($MiniqProcess.ExitCode -eq 0 -and $MiniqHiddenOutput.Trim() -eq "miniq $MiniqTestVersion") 'No-console desktop launcher failed.'
    $MiniqProcess.Dispose()
    $MiniqPointer = Join-Path $env:MINIQ_INSTALL_DIR '.miniq\current-version'
    Assert-True ((Get-Content $MiniqPointer -Raw).Trim() -eq $MiniqTestVersion) 'Missing atomic pair pointer.'
    $MiniqBusy = [IO.File]::Open((Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe'), 'Open', 'Read', 'Read')
    try { & $MiniqInstaller } finally { $MiniqBusy.Dispose() }
    Write-FixtureManifest ('0' * 64)
    $MiniqFailed = $false
    try { & $MiniqInstaller } catch { $MiniqFailed = $_.Exception.Message -match 'checksum mismatch' }
    Assert-True $MiniqFailed 'Checksum mismatch must fail.'
    Assert-True ((Get-Content $MiniqPointer -Raw).Trim() -eq $MiniqTestVersion) 'Checksum failure changed current pair.'

    Write-FixtureManifest $MiniqDigest
    $env:MINIQ_INSTALL_DIR = Join-Path $MiniqFixture 'legacy'
    New-Item -ItemType Directory $env:MINIQ_INSTALL_DIR | Out-Null
    Copy-Item (Join-Path $MiniqRoot 'miniq.exe'), (Join-Path $MiniqRoot 'miniq-daemon.exe') $env:MINIQ_INSTALL_DIR
    $MiniqBefore = (Get-FileHash (Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe')).Hash
    $MiniqBusy = [IO.File]::Open((Join-Path $env:MINIQ_INSTALL_DIR 'miniq-daemon.exe'), 'Open', 'Read', 'Read')
    $MiniqFailed = $false
    try { & $MiniqInstaller } catch { $MiniqFailed = $true } finally { $MiniqBusy.Dispose() }
    Assert-True $MiniqFailed 'Busy legacy daemon must block migration without stopping it.'
    Assert-True ((Get-FileHash (Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe')).Hash -eq $MiniqBefore) 'Blocked migration changed legacy CLI.'
    & $MiniqInstaller
    Assert-True ((& (Join-Path $env:MINIQ_INSTALL_DIR 'miniq.exe') --version) -eq "miniq $MiniqTestVersion") 'Idle legacy migration failed.'
    Write-Host 'Windows installer: native launch, same-version update while launcher locked, checksum rejection, busy legacy preservation, idle migration passed.'
} finally {
    Remove-Item -Recurse -Force $MiniqFixture
}
