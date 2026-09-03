@echo off
setlocal
rem Scientific Reading Workbench - portable local launcher
cd /d "%~dp0"

where py >nul 2>&1
if errorlevel 1 goto python
py -3 "%~dp0tools\serve.py"
goto result

:python
where python >nul 2>&1
if errorlevel 1 goto missing
python "%~dp0tools\serve.py"
goto result

:missing
echo Python 3 was not found. Install Python from https://www.python.org/downloads/
echo Then run this launcher again.
pause
exit /b 1

:result
if errorlevel 1 pause
exit /b %errorlevel%
