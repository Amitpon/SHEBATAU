@echo off
REM Sheba Lab-Value Prediction — one-command launcher.
REM Serves the API and the static frontend on http://localhost:8000
setlocal
cd /d "%~dp0"
set "PY=C:\ProgramData\anaconda3\python.exe"
if not exist "%PY%" set "PY=python"
echo Starting Sheba CDSS on http://localhost:8000  (Ctrl+C to stop)
"%PY%" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
endlocal
