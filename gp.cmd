@echo off
setlocal
cd /d "%~dp0"

if not exist ".git" goto NOGIT
where git >nul 2>nul || goto NOGITBIN

REM --- message & branche ---
set "MSG=%*"
if "%MSG%"=="" set "MSG=chore: quick sync"

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "CURBRANCH=%%b"
if "%CURBRANCH%"=="" set "CURBRANCH=main"

echo.
echo ============================================
echo  🚨 ATTENTION : OPTION B ACTIVE
echo  -> Le contenu de %CURBRANCH% va REMPLACER main
echo ============================================
echo.
echo   local branch : %CURBRANCH%
echo   target       : main
echo   message      : %MSG%
choice /C YN /M "Continue?"
if errorlevel 2 goto ABORT

echo.
echo [1/6] add
git add -A

echo [2/6] commit
git commit -m "%MSG%"
if errorlevel 1 echo (no changes to commit, continue)

echo [3/6] checkout main
git checkout main || goto ERR

echo [4/6] maj main depuis %CURBRANCH%
git pull --rebase origin main || echo (main à jour)
git reset --hard %CURBRANCH% || goto ERR

echo [5/6] push --force-with-lease main
git push --force-with-lease origin main || goto PUSHERR

echo [6/6] retour sur %CURBRANCH%
git checkout %CURBRANCH%

echo.
echo ✅ OK : 'main' sur GitHub reflète maintenant '%CURBRANCH%'
goto END

:NOGIT
echo ❌ Not a git repo: %cd%
goto END

:NOGITBIN
echo ❌ Git not found in PATH.
goto END

:PUSHERR
echo ❌ Push failed.
goto END

:ABORT
echo Aborted by user.
goto END

:ERR
echo ❌ Command failed.
goto END

:END
echo.
echo --- Script termine, appuyez sur une touche pour fermer ---
pause >nul
exit /b 0
