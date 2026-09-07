Unicode true
!include LogicLib.nsh
!include "${TAURI_UTILS}"
!addplugindir "${TAURI_PLUGINS}"
!define MAINBINARYNAME "miniq-updater-test-shell"
!define PRODUCTNAME "miniQ updater test"
!define INSTALLMODE "currentUser"
!include "${HOOK_PATH}"
Name "miniQ updater hook test"
OutFile "${TEST_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
Var PassiveMode
LangString appRunning 1033 "Test app is running"
LangString appRunningOkKill 1033 "Close test app?"
LangString failedToKillApp 1033 "Cannot close test app"
Section
  StrCpy $PassiveMode 1
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
SectionEnd
