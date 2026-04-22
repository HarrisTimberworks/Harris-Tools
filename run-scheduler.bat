@echo off
cd /d C:\Users\chris\Harris-Tools
for /f "delims=" %%i in (.token) do set MONDAY_API_TOKEN=%%i
set LOG=logs\scheduler-%date:~-4%-%date:~4,2%-%date:~7,2%.log
echo ===== %date% %time% ===== >> %LOG%
node scripts\schedule-production-jobs.js >> %LOG% 2>&1
