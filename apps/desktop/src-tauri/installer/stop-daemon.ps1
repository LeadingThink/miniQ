param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"
try {
    $target = [System.IO.Path]::GetFullPath((Join-Path $InstallDir "miniq-daemon.exe"))
    $processes = @(Get-Process -Name "miniq-daemon" -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        if ($process.HasExited) { continue }
        if (-not [string]::Equals($process.Path, $target, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        Write-Output "Stopping miniQ background process $($process.Id)"
        $process.Kill()
        if (-not $process.WaitForExit(10000)) {
            throw "miniQ background process $($process.Id) did not exit within 10 seconds"
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
