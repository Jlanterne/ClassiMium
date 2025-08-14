@echo off
REM === gp.cmd : commit + pull --rebase + push (seulement sur main) ===
setlocal ENABLEEXTENSIONS

REM 1) Se placer dans le dossier du script
cd /d "%~dp0"

REM 2) Git dispo ?
where git >NUL 2>&1 || (echo [ERREUR] Git introuvable & pause & exit /b 1)

REM 3) Dans un repo ?
git rev-parse --is-inside-work-tree >NUL 2>&1 || (echo [ERREUR] Pas un depot Git & pause & exit /b 1)

REM 4) Branche courante
for /f "tokens=*" %%b in ('git branch --show-current 2^>NUL') do set "CUR=%%b"
if "%CUR%"=="" (echo [ERREUR] Branche courante introuvable & pause & exit /b 1)

if /I not "%CUR%"=="main" (
  echo [STOP] Tu n'es pas sur main - branche actuelle: "%CUR%"
  pause
  exit /b 1
)

echo.
echo === Branche active : %CUR% ===

REM 5) Message de commit
set "COMMITMSG=%*"

if "%COMMITMSG%"=="" (
    set /p COMMITMSG=Message de commit :
)

if "%COMMITMSG%"=="" (
    echo [ERREUR] Aucun message
    pause
    exit /b 1
)


echo.
echo === Apercu des modifs ===
git status
echo.

set /p OK=Confirmer l'envoi sur main ? (O/N) : 
if /I not "%OK%"=="O" if /I not "%OK%"=="Y" (
  echo Annule.
  pause
  exit /b 1
)

echo.
echo === Commit ===
git add -A
git commit -m "%COMMITMSG%"
if errorlevel 1 echo (info) Rien a committer, on continue.

echo.
echo === Pull --rebase ===
git pull --rebase

echo.
echo === Push ===
git push

echo.
echo OK : termine sur main.
pause
