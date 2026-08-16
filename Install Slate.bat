@echo off
REM Double-click this to install (or update) Slate on this computer.
REM It puts a Slate icon on your Desktop. Your data is never touched.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\installer\install.ps1"
