@echo off
setlocal
cd /d "%~dp0"

set "APPNAME=ClassiMium"
set "SRC=dist\%APPNAME%"
if "%LOCALAPPDATA%"=="" set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DST=%LOCALAPPDATA%\%APPNAME%"

echo [INFO] Source : %CD%\%SRC%
echo [INFO] Cible  : %DST%

REM 1) Vérifier l'exe source
if not exist "%SRC%\%APPNAME%.exe" (
  echo [ERREUR] %SRC%\%APPNAME%.exe introuvable. Lance d'abord build_release.bat.
  if exist "%SRC%\" dir /b "%SRC%"
  pause
  exit /b 1
)

REM 2) Si un FICHIER "ClassiMium" existe à la place d'un dossier, le supprimer
if exist "%DST%" if not exist "%DST%\NUL" (
  echo [WARN] Un fichier nommé "ClassiMium" existe. Suppression...
  del /f /q "%DST%"
)

REM 3) Créer le dossier cible si besoin
if not exist "%DST%\NUL" mkdir "%DST%"

REM 4) Copier vers le dossier local
where robocopy >NUL 2>&1 && (
  robocopy "%SRC%" "%DST%" /MIR /R:1 /W:1 >NUL
) || (
  xcopy "%SRC%\*" "%DST%\" /E /I /Y >NUL
)

REM 5) Vérifier la copie
if not exist "%DST%\%APPNAME%.exe" (
  echo [ERREUR] Copie incomplète. Contenu de la cible :
  dir /b "%DST%"
  pause
  exit /b 1
)

REM 6) Lancer depuis C:
echo [INFO] Lancement : %DST%\%APPNAME%.exe
start "" "%DST%\%APPNAME%.exe"

timeout /t 2 >NUL
tasklist /fi "imagename eq %APPNAME%.exe" | find /I "%APPNAME%.exe" >NUL
if errorlevel 1 (
  echo [WARN] Le processus ne semble pas actif. Si rien ne s'ouvre,
  echo        fais un build_debug.bat puis lance dist\ClassiMium\ClassiMium.exe pour voir les logs.
  pause
) else (
  echo [OK] Application lancée depuis %DST%
  timeout /t 2 >NUL
)
