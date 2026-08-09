; ============================================================================
; RX Store — per-user Windows installer (assisted wizard)
;
; Custom NSIS script for electron-builder (build.nsis.script). It replaces the
; stock two-pass flow, which compiles an uninstaller stub and then RUNS the
; stub under Wine to harvest the uninstaller exe. That step cannot work on
; Ubuntu GitHub runners: noble's wine64 ships no loader on PATH
; ("wine: could not exec the wine loader"), and no usable wrapper exists.
;
; Instead, the uninstaller is written by NSIS itself at install time on the
; user's machine (classic WriteUninstaller), so the entire build runs
; natively on a Linux runner — makensis needs no Wine at all.
;
; Compile-time inputs supplied by electron-builder (verified in
; app-builder-lib/targets/nsis/NsisTarget#build):
;   defines : PRODUCT_NAME, PRODUCT_FILENAME, APP_FILENAME, APP_ID, APP_GUID,
;             UNINSTALL_APP_KEY, VERSION, APP_DESCRIPTION, PROJECT_DIR,
;             BUILD_RESOURCES_DIR, COMPANY_NAME, SHORTCUT_NAME, COMPRESS,
;             APP_64 (+ _NAME, _UNPACKED_SIZE) — the x64 payload archive,
;             MUI_ICON / MUI_UNICON / sidebar bitmaps when provided
;   commands: OutFile, VIProductVersion, VIAddVersionKey, Unicode, SetCompressor
;   header  : addLangs (MUI_LANGUAGE blocks), messages.nsh LangStrings,
;             plugin dirs (Nsis7z), StdUtils
; common.nsh additionally defines APP_EXECUTABLE_FILENAME = "${PRODUCT_FILENAME}.exe"
; and UNINSTALL_FILENAME = "Uninstall ${PRODUCT_FILENAME}.exe".
; ============================================================================

!include "common.nsh"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "extractAppPackage.nsh"

RequestExecutionLevel user ; per-user install — no UAC prompt
InstallDir "$LocalAppData\Programs\${APP_FILENAME}"

; ------------------------------ wizard pages ------------------------------
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ------------------------------- install ----------------------------------
Section "Install"
  SetOutPath $INSTDIR

  ; Replace-in-place over a running copy (auto-update / reinstall): close it
  ; first so the payload can overwrite the exe. Errors are fine — nothing to kill.
  nsExec::ExecToStack 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  Sleep 400

  ; Embed app-64.7z (from the electron-builder define APP_64) and unpack it
  ; into $INSTDIR with the stock macro (7z-out staging + atomic copy + retries).
  !insertmacro extractEmbeddedAppPackage

  ; Uninstaller — produced here, on the user's machine. No Wine anywhere.
  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"

  ; Shortcuts: Desktop + Start Menu (per-user hive)
  CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "" "" "" "" "${APP_DESCRIPTION}"
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "" "" "" "" "${APP_DESCRIPTION}"
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}\${UNINSTALL_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"

  ; Add/Remove Programs (HKCU — per-user install)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !ifdef COMPANY_NAME
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "Publisher" "${COMPANY_NAME}"
  !endif
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALL_FILENAME}"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALL_FILENAME}" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoRepair" 1
SectionEnd

; ------------------------------ uninstall ---------------------------------
Section "Uninstall"
  ; Stop a running instance before files disappear (silent uninstalls included).
  nsExec::ExecToStack 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  Sleep 400

  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${SHORTCUT_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
  ; User data in %APPDATA% is intentionally kept — settings survive upgrades.
SectionEnd

; Language files must come AFTER every MUI_[UN]PAGE_* macro — MUI2's
; MUI_LANGUAGEEX warns on the reverse order, and electron-builder compiles
; with -WX (warnings are fatal). addLangs loads every language the config
; prepared plus the message strings ($(…) used by the extract macro).
!insertmacro addLangs
