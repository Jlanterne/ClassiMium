@echo off
setlocal ENABLEDELAYEDEXPANSION

REM == Toujours partir de ce dossier ==
cd /d "%~dp0"

echo [INFO] Dossier courant : %CD%
echo [INFO] Verification de l'executable...

set "EXE=dist\ClassiMium\ClassiMium.exe"

REM == Affiche l'arbo pour debug rapide ==
if not exist "dist\" (
  echo [WARN] Le dossier "dist" n'existe pas.
) else (
  echo [INFO] Contenu de dist\ :
  dir /b dist
  echo.
)

REM == Si l'exe n'existe pas, on lance le build release automatiquement ==
if not exist "%EXE%" (
  echo [WARN] "%EXE%" introuvable. Lancement de build_release.bat...
  if exist "build_release.bat" (
    call build_release.bat
  ) else (
    echo [ERREUR] build_release.bat est introuvable dans %CD%
    echo Place ce script a la racine du projet (avec run.py, desktop_app.py).
    pause
    exit /b 1
  )
)

REM == Re-verif apres build ==
if not exist "%EXE%" (
  echo [ERREUR] Echec: l'exe "%EXE%" est toujours introuvable apres build.
  echo Verifie les messages d'erreur affiches pendant la compilation.
  pause
  exit /b 1
)

echo [INFO] Lancement de : %EXE%
REM Astuce: /D fixe le dossier de demarrage, ca evite des problemes de chemins relatifs
start "" /D "dist\ClassiMium" "ClassiMium.exe"

REM On laisse un court delai pour voir s'il y a un blocage immediat
timeout /t 2 >NUL
echo [INFO] Commande envoyee. Si rien ne s'ouvre, re-essaie en debug:
echo        1) build_debug.bat
echo        2) lancer dist\ClassiMium\ClassiMium.exe
pause
