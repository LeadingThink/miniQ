$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MiniqConsoleProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
'@
if ([MiniqConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) {
    throw 'Background process unexpectedly has a Windows console window'
}
[Console]::Out.WriteLine('miniq-no-console')
[Console]::Error.WriteLine('miniq-stderr')
