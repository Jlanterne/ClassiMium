@echo off
cd /d "%~dp0"
set "SRC=dist\ClassiMium"
if "%LOCALAPPDATA%"=="" set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DST=%LOCALAPPDATA%\ClassiMium_Debug"

if not exist "%SRC%\ClassiMium.exe" (
  echo [ERREUR] Build debug manquant. Lance d'abord build_debug.bat.
  pause & exit /b 1
)

echo [INFO] Copie vers %DST% ...
mkdir "%DST%" >NUL 2>&1
where robocopy >NUL 2>&1 && (
  robocopy "%SRC%" "%DST%" /MIR /R:1 /W:1 >NUL
) || (
  xcopy "%SRC%\*" "%DST%\" /E /I /Y >NUL
)

echo [INFO] Lancement local...
start "" "%DST%\ClassiMium.exe"
pause
