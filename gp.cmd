@echo off
setlocal
cd /d "%~dp0"

if not exist ".git" goto NOGIT
where git >nul 2>nul || goto NOGITBIN

set "MSG=%*"
if "%MSG%"=="" set "MSG=chore: quick sync"

echo [1/4] add
git add -A

echo [2/4] commit
git commit -m "%MSG%"
if errorlevel 1 echo (no changes to commit, continue)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
if "%BRANCH%"=="" set "BRANCH=main"

echo [3/4] pull --rebase origin %BRANCH%
git pull --rebase origin %BRANCH% || goto REBASEERR

echo [4/4] push
git push || goto PUSHERR

echo OK pushed to %BRANCH%
pause
exit /b 0

:NOGIT
echo Not a git repo: %cd%
pause
exit /b 1

:NOGITBIN
echo Git not found in PATH.
pause
exit /b 1

:REBASEERR
echo Rebase failed. Resolve conflicts, then:
echo   git add <files>
echo   git rebase --continue
pause
exit /b 1

:PUSHERR
echo Push failed.
pause
exit /b 1
