@echo off
setlocal
cd /d "%~dp0"
if exist .venv\Scripts\activate call .venv\Scripts\activate
set FLASK_APP=app.py
set FLASK_DEBUG=1
python -m flask run --host=127.0.0.1 --port=5000
pause
