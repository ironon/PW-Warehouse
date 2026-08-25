@echo off
REM Starts the PW-Warehouse label printing backend on http://127.0.0.1:8765
REM Leave this window open while using the app's label printing.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :error
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
)

echo Starting label printer server on http://127.0.0.1:8765
".venv\Scripts\python.exe" -m label_printer.server
goto :eof

:error
echo.
echo Setup failed. Make sure Python 3.10+ is installed and on your PATH.
pause
