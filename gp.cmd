@echo off
REM === gp.cmd : Génère DEBUG_LINKS.md + commit + pull --rebase + push (branche main) ===
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION

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

REM 5) Récupérer le nom du repo "owner/name" depuis origin
for /f "usebackq tokens=*" %%r in (`git config --get remote.origin.url`) do set "ORIGIN=%%r"
if "%ORIGIN%"=="" (echo [ERREUR] Remote origin introuvable & pause & exit /b 1)

set "REPO=%ORIGIN%"
REM Forme SSH: git@github.com:owner/name.git
if /I "%REPO:~0,15%"=="git@github.com:" set "REPO=%REPO:git@github.com:=%"
REM Forme HTTPS: https://github.com/owner/name(.git)
if /I "%REPO:~0,19%"=="https://github.com/" set "REPO=%REPO:https://github.com/=%"
if /I "%REPO:~0,18%"=="http://github.com/"  set "REPO=%REPO:http://github.com/=%"
REM Enlever suffixe .git
if /I "%REPO:~-4%"==".git" set "REPO=%REPO:~0,-4%"

set "BLOBBASE=https://github.com/!REPO!/blob/!CUR!/"
set "RAWBASE=https://raw.githubusercontent.com/!REPO!/!CUR!/"

REM 6) Générer DEBUG_LINKS.md (avec horodatage)
echo # Debug links > DEBUG_LINKS.md
echo >^> Généré automatiquement par gp.cmd le %date% %time% >> DEBUG_LINKS.md
echo >^> Repo: !REPO! — Branche: !CUR! >> DEBUG_LINKS.md
echo. >> DEBUG_LINKS.md

REM Lister TOUS les fichiers suivis par Git
for /f "delims=" %%f in ('git ls-files') do (
  echo - %%f>> DEBUG_LINKS.md
  echo   !BLOBBASE!%%f>> DEBUG_LINKS.md
  echo   !RAWBASE!%%f>> DEBUG_LINKS.md
)

REM 7) Message de commit
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
