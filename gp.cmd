@echo off
REM === gp.cmd : Génère DEBUG_LINKS.md + commit + pull --rebase + push (branche courante) ===
setlocal EnableExtensions EnableDelayedExpansion

:: 1) Se placer dans le dossier du script
cd /d "%~dp0"

:: 2) Git dispo ?
where git >NUL 2>&1 || (echo [ERREUR] Git introuvable & pause & exit /b 1)

:: 3) Dans un repo ?
git rev-parse --is-inside-work-tree >NUL 2>&1 || (echo [ERREUR] Pas un dépôt Git & pause & exit /b 1)

:: 4) Branche courante
for /f "tokens=*" %%b in ('git branch --show-current 2^>NUL') do set "CUR=%%b"
if "%CUR%"=="" (echo [ERREUR] Branche courante introuvable & pause & exit /b 1)

echo(
echo === Branche active : %CUR% ===

:: 5) Remote origin
for /f "usebackq tokens=*" %%r in (`git config --get remote.origin.url`) do set "ORIGIN=%%r"
if "%ORIGIN%"=="" (
  echo [ERREUR] Remote "origin" absent.
  echo Ajoute-le puis relance :  git remote add origin https://github.com/<user>/<repo>.git
  pause
  exit /b 1
)

:: 6) Construire owner/repo pour les liens
set "REPO=%ORIGIN%"
if /I "%REPO:~0,15%"=="git@github.com:" set "REPO=%REPO:git@github.com:=%"
if /I "%REPO:~0,19%"=="https://github.com/" set "REPO=%REPO:https://github.com/=%"
if /I "%REPO:~0,18%"=="http://github.com/"  set "REPO=%REPO:http://github.com/=%"
if /I "%REPO:~-4%"==".git" set "REPO=%REPO:~0,-4%"

set "BLOBBASE=https://github.com/!REPO!/blob/!CUR!/"
set "RAWBASE=https://raw.githubusercontent.com/!REPO!/!CUR!/"

:: 7) Générer DEBUG_LINKS.md
>DEBUG_LINKS.md echo # Debug links
>>DEBUG_LINKS.md echo Généré automatiquement par gp.cmd le %date% %time%
>>DEBUG_LINKS.md echo Repo: !REPO! — Branche: !CUR!
>>DEBUG_LINKS.md echo(
for /f "delims=" %%f in ('git ls-files') do (
  >>DEBUG_LINKS.md echo - %%f
  >>DEBUG_LINKS.md echo   !BLOBBASE!%%f
  >>DEBUG_LINKS.md echo   !RAWBASE!%%f
  >>DEBUG_LINKS.md echo(
)

:: 8) Message de commit
set "COMMITMSG=%*"
if "%COMMITMSG%"=="" (
  set /p COMMITMSG=Message de commit : 
)
if "%COMMITMSG%"=="" (
  echo [ERREUR] Aucun message saisi.
  pause
  exit /b 1
)

echo(
echo === Aperçu des modifs ===
git status
echo(

set /p OK=Confirmer l'envoi vers origin/%CUR% ? (O/N) : 
if /I not "%OK%"=="O" if /I not "%OK%"=="Y" (
  echo Annulé.
  pause
  exit /b 0
)

echo(
echo === Commit ===
git add -A
git commit -m "%COMMITMSG%"
if errorlevel 1 echo (info) Rien à committer, on continue.

echo(
echo === Pull --rebase ===
git pull --rebase --autostash origin "%CUR%"

echo(
echo === Push ===
git push origin "%CUR%"

echo(
echo OK : terminé sur origin/%CUR%.
pause
