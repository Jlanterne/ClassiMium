@echo off
setlocal ENABLEEXTENSIONS
cd /d "%~dp0"
where python >NUL 2>&1 || (echo [ERREUR] Python introuvable & pause & exit /b 1)
python desktop_app.py
