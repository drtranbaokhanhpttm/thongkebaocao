@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Dang mo ung dung phan tich...
echo.
start "" http://localhost:4173
python -m http.server 4173
pause
