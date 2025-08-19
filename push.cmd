@echo off
cd /d "%~dp0"
where git >NUL 2>&1 || (echo [ERREUR] Git introuvable & pause & exit /b 1)

REM init si besoin
if not exist ".git" (
  git init
  git branch -M main
)

REM remote origin ? (si non, ? mettre une fois : git remote add origin https://github.com/<user>/<repo>.git)
git remote -v || echo [INFO] Pas de remote origin encore. Utilise : git remote add origin https://github.com/<user>/<repo>.git

echo.
git status
echo.
set /p MSG=Message de commit : 
if "%MSG%"=="" (echo [ERREUR] Aucun message & pause & exit /b 1)

git add -A
git commit -m "%MSG%"
git pull --rebase --autostash
git push -u origin main
echo.
echo [OK] Pousse sur main termine.
pause
