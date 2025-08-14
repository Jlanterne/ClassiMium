@echo off
setlocal
cd /d "%~dp0"

if not exist ".git" goto NOGIT
where git >nul 2>nul || goto NOGITBIN

REM --- message & branche avant confirmation ---
set "MSG=%*"
if "%MSG%"=="" set "MSG=chore: quick sync"

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
if "%BRANCH%"=="" set "BRANCH=main"

echo.
echo About to push:
echo   branch : %BRANCH%
echo   message: %MSG%
choice /C YN /M "Continue?"
if errorlevel 2 goto ABORT

echo.
echo [1/4] add
git add -A

echo [2/4] commit
git commit -m "%MSG%"
if errorlevel 1 echo (no changes to commit, continue)

echo [3/4] pull --rebase origin %BRANCH%
git pull --rebase origin %BRANCH% || goto REBASEERR

echo [4/4] push
git push || goto PUSHERR

echo.
echo ✅ OK pushed to %BRANCH%
goto END

:NOGIT
echo ❌ Not a git repo: %cd%
goto END

:NOGITBIN
echo ❌ Git not found in PATH.
goto END

:REBASEERR
echo ❌ Rebase failed. Resolve conflicts, then:
echo   git add <files>
echo   git rebase --continue
goto END

:PUSHERR
echo ❌ Push failed.
goto END

:ABORT
echo Aborted by user.
goto END

:END
echo.
echo --- Script termine, appuyez sur une touche pour fermer ---
pause >nul
exit /b 0
