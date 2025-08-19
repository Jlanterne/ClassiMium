@echo off
cd /d "%~dp0"

echo [1/3] Desinstallation de CEF (si present)...
python -m pip uninstall -y cefpython3

echo [2/3] Mise a jour pip...
python -m pip install -U pip

echo [3/3] Installation deps (pywebview + pythonnet + waitress)...
python -m pip install -U pywebview pythonnet waitress

echo.
echo === Deps OK. Appuie sur une touche pour fermer. ===
pause
