@echo off
setlocal
cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
set "BASE_PY="

if exist "%VENV_PY%" goto install_requirements

for %%V in (python3.14.exe python3.13.exe python3.12.exe python3.11.exe python3.10.exe) do (
  if not defined BASE_PY if exist "%LOCALAPPDATA%\Python\bin\%%V" set "BASE_PY=%LOCALAPPDATA%\Python\bin\%%V"
)

for %%V in (314 313 312 311 310) do (
  if not defined BASE_PY if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" set "BASE_PY=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
)

if not defined BASE_PY (
  for /f "delims=" %%P in ('where python 2^>nul') do if not defined BASE_PY set "BASE_PY=%%P"
)

if not defined BASE_PY (
  echo Python 3.10 or newer was not found.
  echo Install Python and enable Add Python to PATH, then run this file again.
  pause
  exit /b 1
)

echo Preparing the website's private Python environment...
"%BASE_PY%" -m venv "%~dp0.venv"
if errorlevel 1 goto setup_error

:install_requirements
echo Checking website requirements...
"%VENV_PY%" -m pip install -r requirements.txt
if errorlevel 1 goto setup_error

echo Starting ON BY INCENSE DESIGN at http://127.0.0.1:8000
echo Open that address in your browser. Do not use Live Server or open index.html directly.
echo Keep this window open; closing it stops the Python server.
"%VENV_PY%" -m uvicorn server:app --reload
if errorlevel 1 goto setup_error
exit /b 0

:setup_error
echo Website startup failed. Check the message above, then try again.
pause
exit /b 1
