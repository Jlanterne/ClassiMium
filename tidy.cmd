@echo off
setlocal ENABLEDELAYEDEXPANSION

REM === Toujours lancer depuis C:\ClassiMium_local ===
cd /d "%~dp0"
echo [INFO] Dossier courant : %CD%

REM Timestamp pour le dossier poubelle local
for /f %%i in ('powershell -NoProfile -Command Get-Date -Format "yyyyMMdd_HHmmss"') do set "STAMP=%%i"
set "TRASH=.trash_%STAMP%"
mkdir "%TRASH%" >NUL 2>&1

echo(
echo [PLAN] Les éléments suivants seront deplaces vers "%TRASH%" si presents :
echo   - build\, dist\, venvs (.venv*, venv*, env)
echo   - __pycache__ (partout), *.pyc/*.pyo
echo   - *.spec, startup_error.log, edge_test.py
echo   - step1_desktop_hello\, step2_flask_desktop\
echo(
set /p OK=On y va ? (O/N) : 
if /I not "%OK%"=="O" if /I not "%OK%"=="Y" (
  echo Annule.
  pause
  exit /b 0
)

echo(
echo [1/4] Deplacement des dossiers courants de build/venv...
for %%D in (build dist .venv .venv_edge venv venv_edge env step1_desktop_hello step2_flask_desktop) do (
  if exist "%%D\" (
    echo   [MOVE] %%D\  ->  %TRASH%\%%D\
    robocopy "%%D" "%TRASH%\%%D" /MIR >NUL
    rmdir /s /q "%%D"
  )
)

echo [2/4] Suppression recursive des __pycache__ ...
for /d /r %%d in (__pycache__) do (
  echo   [DEL] %%d
  rmdir /s /q "%%d"
)

echo [3/4] Deplacement des fichiers temporaires...
if not exist "%TRASH%\files" mkdir "%TRASH%\files" >NUL 2>&1
for %%F in (startup_error.log *.spec edge_test.py) do (
  for %%G in ("%%F") do (
    if exist "%%~G" (
      echo   [MOVE] %%~G  ->  %TRASH%\files\
      move /y "%%~G" "%TRASH%\files" >NUL
    )
  )
)

echo [4/4] Suppression des *.pyc / *.pyo...
for /r %%f in (*.pyc *.pyo) do del /q "%%f"

echo(
if not exist ".gitignore" (
  echo [INFO] Creation d'un .gitignore minimal...
  > ".gitignore" echo # Python
  >> ".gitignore" echo __pycache__/
  >> ".gitignore" echo *.py[cod]
  >> ".gitignore" echo *.pyo
  >> ".gitignore" echo
  >> ".gitignore" echo # Virtual envs
  >> ".gitignore" echo .venv*/
  >> ".gitignore" echo venv/
  >> ".gitignore" echo env/
  >> ".gitignore" echo
  >> ".gitignore" echo # PyInstaller
  >> ".gitignore" echo build/
  >> ".gitignore" echo dist/
  >> ".gitignore" echo *.spec
  >> ".gitignore" echo
  >> ".gitignore" echo # OS
  >> ".gitignore" echo Thumbs.db
  >> ".gitignore" echo .DS_Store
  >> ".gitignore" echo
  >> ".gitignore" echo # Logs
  >> ".gitignore" echo startup_error.log
)

echo(
echo [OK] Ménage terminé.
echo [INFO] Tout le bazar est dans : %TRASH%
echo [INFO] Apercu :
dir /b "%TRASH%"
echo(
echo Astuce : lance ensuite build_release.bat puis Launch_Local.cmd si besoin.
pause
