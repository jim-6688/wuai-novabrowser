@echo off
REM ============================================================================
REM  Build trident-host.exe (Nova's native IE/Trident host)
REM  No Visual Studio needed: uses the system .NET Framework csc.
REM  Output is copied to native\bin\trident-host.exe (this is the path Nova probes).
REM ============================================================================
setlocal

REM repo root: from this script (native\host) go up two levels
set "ROOT=%~dp0..\.."
set "OUTDIR=%ROOT%\native\bin"
set "OUT=%OUTDIR%\trident-host.exe"

REM locate a usable csc (.NET Framework 4.x); prefer the 32-bit framework dir
set "CSC=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] Cannot find .NET Framework csc.exe.
  echo         Install the .NET Framework 4.7.2 Developer Pack, or build from
  echo         the Visual Studio Developer Command Prompt.
  exit /b 1
)

if not exist "%OUTDIR%" mkdir "%OUTDIR%"

echo [1/2] Compiling with %CSC% (/platform:x86, /codepage:utf8)...
"%CSC%" /nologo /target:exe /platform:x86 /codepage:65001 /out:"%OUT%" ^
  /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll ^
  "%~dp0trident-host\Program.cs"
if errorlevel 1 (
  echo [FAILED] Compile error, see csc output above.
  exit /b 1
)

echo [2/2] Built: %OUT%
echo.
echo Done. Restart Nova, then open Settings - Engine Bridge - Re-probe native
echo hosts. IE/Trident should flip from "compat layer" to "native bridge".
endlocal
