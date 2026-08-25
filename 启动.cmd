@echo off
rem ============================================================
rem  Video Understanding Workbench - local launcher (ASCII only)
rem  Serves the workbench UI at http://127.0.0.1:8686/
rem
rem  Python preference order:
rem    1) BUNDLED runtime in "python\python.exe" (self-contained build,
rem       target PC does NOT need Python installed) - used when present
rem    2) any system Python 3.8+ found on PATH / common install locations
rem  Requires Python 3.8 or newer (standard library only).
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Video Understanding Workbench (DashScope Bailian)

set "PYCMD="
set "PYARGS="
set "PYVER="
set "PYVER2="

rem ---- 0) package integrity: all required files must sit next to this launcher ----
if not exist "%~dp0server.py" goto :badpackage
if not exist "%~dp0index.html" goto :badpackage
if not exist "%~dp0assets\app.js" goto :badpackage
if not exist "%~dp0assets\style.css" goto :badpackage

rem ---- 1) bundled Python (self-contained build ships a portable runtime here) ----
if exist "%~dp0python\python.exe" call :probe "%~dp0python\python.exe" ""

rem ---- 2) python (bare name from PATH) ----
call :probe python ""

rem ---- 3) every python path found on PATH (full path, may be several) ----
for /f "delims=" %%i in ('where python 2^>nul') do call :probe "%%i" ""

rem ---- 4) local Python install (no PATH dependency) ----
if not defined PYCMD if exist "%LOCALAPPDATA%\Python\bin\python.exe" call :probe "%LOCALAPPDATA%\Python\bin\python.exe" ""

rem ---- 5) Python core install directory ----
if not defined PYCMD (
  for /d %%d in ("%LOCALAPPDATA%\Python\pythoncore-*") do (
    if not defined PYCMD if exist "%%d\python.exe" call :probe "%%d\python.exe" ""
  )
)

rem ---- 6) py launcher (validated; Store stub / old versions are skipped) ----
if not defined PYCMD (
  for /f "delims=" %%i in ('where py 2^>nul') do call :probe "%%i" "-3"
)

if not defined PYCMD goto :notfound

echo.
echo Starting Video Understanding Workbench ...
echo Python: %PYCMD% %PYARGS%   (%PYVER%)
if exist "%~dp0python\python.exe" echo Mode: self-contained (bundled Python, no install needed)
echo (Keep this window open while using the app; close it to stop.)
echo.
"%PYCMD%" %PYARGS% server.py
set "RC=%errorlevel%"
echo.
echo Server exited (code %RC%).
pause
exit /b %RC%

rem ============================================================
rem  bad package: required files missing next to the launcher
rem ============================================================
:badpackage
echo.
echo [ERROR] The project files are incomplete.
echo   Missing files: check server.py / index.html / assets\app.js / assets\style.css
echo   Please copy the WHOLE project folder to this computer and re-run this
echo   launcher. Do not copy single files or shortcuts.
echo.
pause
exit /b 1

rem ============================================================
rem  no usable Python found
rem ============================================================
:notfound
echo.
echo [ERROR] Python 3.8+ was not found usable on this computer.
if defined PYVER2 (
  echo   Detected: %PYVER2%
) else (
  echo   Detected: No Python found in PATH or common install locations.
)
echo.
echo   What this means:
echo     - "Python was not found..." above means the Microsoft Store version
echo       is not installed. Install Python from python.org.
echo     - An old version number above means Python is too old (3.8+ is needed;
echo       version 3.6 and older do NOT work).
echo.
echo   How to install:
echo     1. Open https://www.python.org/downloads/
echo        (Windows click "Download Python 3.x" - the latest 3.12/3.13/3.14)
echo     2. During install CHECK the box "Add python.exe to PATH"
echo     3. Then re-run this launcher.
echo.
echo   Alternative: run the launcher from a terminal (cmd):
echo     cd /d "%~dp0"
echo     py -3 server.py
echo.
echo   NOTE: If this is the self-contained shared build, the "python\python.exe"
echo   runtime should be present. If it is missing, the folder is incomplete and
echo   the whole package must be re-copied.
echo.
pause
exit /b 1

rem ============================================================
rem  probe <exe> <args>
rem  Picks the first candidate that passes the version check.
rem  Microsoft Store stubs and Python below 3.8 are skipped.
rem ============================================================
:probe
if defined PYCMD goto :eof
set "TEXE=%~1"
set "TARGS=%~2"
if not defined TEXE goto :eof
if not "%~1"=="python" if not exist "%TEXE%" goto :eof
"%TEXE%" %TARGS% -c "import sys;raise SystemExit(0 if sys.version_info>=(3,8) else 2)" >nul 2>nul
if not errorlevel 1 (
  set "PYCMD=%TEXE%"
  set "PYARGS=%TARGS%"
  for /f "delims=" %%v in ('"%TEXE%" %TARGS% -V 2^>^&1') do (
    if not defined PYVER set "PYVER=%%v"
  )
) else (
  rem remember the failing candidate for the error message (full paths only;
  rem a bare "python" that is not recognized tells us nothing useful)
  if not "%~1"=="python" (
    for /f "delims=" %%v in ('"%TEXE%" %TARGS% -V 2^>^&1') do (
      if not defined PYVER2 set "PYVER2=%%v  (%TEXE%)"
    )
    if not defined PYVER2 set "PYVER2=Found a Python, but it fails the 3.8+ check (%TEXE%)"
  )
)
goto :eof
