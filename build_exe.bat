@echo off
REM ============================================================
REM  build_exe.bat : génère ClassiMium.exe avec PyInstaller
REM ============================================================

cd /d "%~dp0"

REM Vérif Python dispo
where python >NUL 2>&1 || (
    echo [ERREUR] Python introuvable
    pause
    exit /b 1
)

echo [INFO] Nettoyage anciens builds...
rmdir /s /q build dist >NUL 2>&1
del /q ClassiMium.spec >NUL 2>&1

echo [INFO] Lancement de PyInstaller...
python -m PyInstaller desktop_app.py ^
  --name ClassiMium ^
  --noconsole ^
  --add-data "templates;templates" ^
  --add-data "static;static" ^
  --hidden-import waitress ^
  --hidden-import webview

echo.
echo ============================================================
echo   Build termine !
echo   Ton exe est ici : dist\ClassiMium\ClassiMium.exe
echo ============================================================
pause
