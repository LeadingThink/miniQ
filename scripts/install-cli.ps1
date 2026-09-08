param([string]$InstallDir = $(if ($env:MINIQ_INSTALL_DIR) { $env:MINIQ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'miniQ\bin' }))
$ErrorActionPreference = 'Stop'
$MiniqSourceDir = Split-Path $PSScriptRoot -Parent
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Install Rust and Visual Studio C++ Build Tools first: https://rustup.rs/'
}
Push-Location $MiniqSourceDir
try {
    cargo build --release --locked -p miniq-cli -p miniq-daemon --bin miniq --bin miniq-daemon
    if ($LASTEXITCODE -ne 0) { throw 'miniQ build failed; existing installation was not changed.' }
    $MiniqBuildDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $MiniqSourceDir 'target' }
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    foreach ($MiniqProgram in @('miniq.exe', 'miniq-daemon.exe')) {
        $MiniqDestination = Join-Path $InstallDir $MiniqProgram
        $MiniqStage = Join-Path $InstallDir ('.' + [guid]::NewGuid().ToString() + '.exe')
        Copy-Item (Join-Path $MiniqBuildDir "release\$MiniqProgram") $MiniqStage
        try { Move-Item -Force $MiniqStage $MiniqDestination }
        catch { throw "Cannot replace $MiniqDestination, possibly in use. No process was stopped. The built file remains at $MiniqStage. Retry when tasks are idle. $_" }
    }
    & (Join-Path $InstallDir 'miniq.exe') --version
    Write-Host "Installed into $InstallDir. Add this directory to your user PATH."
    Write-Host 'No miniQ process was restarted. Run miniq doctor after a safe restart.'
    Write-Host 'PDF vision requires Poppler pdfinfo.exe and pdftoppm.exe on PATH.'
} finally { Pop-Location }
