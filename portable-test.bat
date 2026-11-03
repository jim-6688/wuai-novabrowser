@echo off
rem ===================================================================
rem  Nova Browser - portable (unpacked) test launcher
rem
rem  What this does:
rem    Runs the unpacked build from dist\win-unpacked with its OWN
rem    user-data dir. That matters because the portable build and the
rem    installed one share the same single-instance lock: without a
rem    separate profile, the second instance quits instantly and just
rem    hands its window to the running one - looks like "double-click
rem    did nothing".
rem
rem  Notes:
rem    - This file is ASCII-only on purpose. cmd parses .bat in the
rem      console codepage, and UTF-8 Chinese in here turns into syntax
rem      errors.
rem    - The exe has a Chinese name, and "dir /b" output gets mangled
rem      by the console codepage, so PowerShell resolves the path
rem      instead (it is Unicode-clean).
rem ===================================================================
setlocal
set "APPDIR=%~dp0dist\win-unpacked"
set "PROFILE=%LOCALAPPDATA%\NovaPortableTest"

if not exist "%APPDIR%" (
  echo [x] Not found: %APPDIR%
  echo     Run this once in the project root:  npm run pc:dir
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$e = (Get-ChildItem -LiteralPath '%APPDIR%' -Filter '*.exe' -File | Select-Object -First 1).FullName;" ^
  "if (-not $e) { Write-Host '[x] No executable found under %APPDIR%'; exit 1 };" ^
  "Start-Process -FilePath $e -ArgumentList '--user-data-dir=\"%PROFILE%\"';" ^
  "Write-Host '[ok] Nova portable test build launched.';" ^
  "Write-Host ('     Profile: %PROFILE%')"

if errorlevel 1 pause
endlocal
