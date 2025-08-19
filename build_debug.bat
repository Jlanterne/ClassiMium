@echo off
cd /d "%~dp0"
where python >NUL 2>&1 || (echo [ERREUR] Python introuvable & pause & exit /b 1)

echo [INFO] Nettoyage anciens builds...
rmdir /s /q build dist >NUL 2>&1
del /q ClassiMium.spec >NUL 2>&1

set "ADDDATA="
if exist "templates\"       set "ADDDATA=%ADDDATA% --add-data templates;templates"
if exist "static\"          set "ADDDATA=%ADDDATA% --add-data static;static"
if exist "app\templates\"   set "ADDDATA=%ADDDATA% --add-data app\templates;templates"
if exist "app\static\"      set "ADDDATA=%ADDDATA% --add-data app\static;static"

echo [INFO] Construction exe (mode console)...
python -m PyInstaller desktop_app.py --name ClassiMium --console %ADDDATA% ^
  --hidden-import pythonnet --hidden-import clr ^
  --collect-all webview --collect-all pythonnet ^
  --collect-submodules webview.platforms.edgechromium ^
  --collect-submodules webview.platforms.winforms

echo(
echo === Build termine ===
echo Exe debug : dist\ClassiMium\ClassiMium.exe
pause
