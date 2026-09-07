!define MINIQ_INSTALLER_DIR "${__FILEDIR__}"
!include x64.nsh

!macro NSIS_HOOK_PREINSTALL
  ; Stop the desktop first so older versions cannot respawn the sidecar.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  InitPluginsDir
  Push $0
  Push $1
  File /oname=$PLUGINSDIR\miniq-stop-daemon.ps1 "${MINIQ_INSTALLER_DIR}\stop-daemon.ps1"
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ; NSIS is 32-bit; native PowerShell can inspect 64-bit process image paths.
  ${If} ${RunningX64}
    StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToStack '"$0" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\miniq-stop-daemon.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP "Unable to stop the miniQ background process. Close miniQ and run the installer again." /SD IDOK
    Abort
  ${EndIf}
  Pop $1
  Pop $0
!macroend
