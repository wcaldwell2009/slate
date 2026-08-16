@echo off
REM This runs the WORKSHOP copy of Slate on http://localhost:4173 — the one used
REM for trying out changes. It has its own sample data and cannot touch the real
REM app or your school work.
REM
REM For the real Slate, use the Slate icon on your Desktop.
REM (Don't have one? Double-click "Install Slate.bat" first.)
cd /d "%~dp0"
node server.js
pause
