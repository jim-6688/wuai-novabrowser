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

REM Nova 可能正把这个宿主拉起来跑着。此时 csc 会报 CS0016（输出文件被占用），
REM 整个 pc:build 会因此失败。直接 taskkill：没在跑时它返回非 0，忽略即可。
REM （不要用 tasklist|find 探测 —— 在 Git Bash 的 PATH 下 find 会解析成 Unix 的 find。）
taskkill /IM trident-host.exe /F >nul 2>&1
if not errorlevel 1 (
  echo [i] trident-host.exe was running - closed it so the output can be replaced.
  REM 给系统一点时间释放文件句柄（timeout 在非交互环境里不可靠，用 ping 等）
  ping -n 2 127.0.0.1 >nul
)

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
