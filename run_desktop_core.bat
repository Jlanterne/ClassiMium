@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

echo [INFO] Dossier courant : %CD%
set "EXE=dist\ClassiMium\ClassiMium.exe"
echo [INFO] Chemin attendu de l'exe : %EXE%

if not exist "dist" (
  echo [WARN] Le dossier dist est absent
)

if not exist "%EXE%" (
  echo [ERREUR] L'exe est introuvable. Lance build_release.bat (ou build_debug.bat) d'abord.
  pause
  exit /b 1
)

echo [INFO] Lancement de l'application...
pushd "dist\ClassiMium"
ClassiMium.exe
set "ERR=%ERRORLEVEL%"
popd

echo [INFO] Process terminé avec code %ERR%
pause
