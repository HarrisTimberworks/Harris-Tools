@echo off
REM Daily rollups for Harris Timberworks — runs all 3 scripts in sequence
REM Scheduled via Windows Task Scheduler at 6:00 AM MST

cd /d C:\Users\chris\Harris-Tools

REM Load API token from file
for /f "delims=" %%i in (C:\Users\chris\Harris-Tools\.token) do set MONDAY_API_TOKEN=%%i

REM Timestamped log file
set LOG=C:\Users\chris\Harris-Tools\logs\rollup-%date:~-4%-%date:~4,2%-%date:~7,2%.log

echo ===== START %date% %time% ===== >> %LOG%

echo. >> %LOG%
echo --- rollup-time-off.js --- >> %LOG%
node scripts\rollup-time-off.js >> %LOG% 2>&1

echo. >> %LOG%
echo --- rollup-cc-non-production.js --- >> %LOG%
node scripts\rollup-cc-non-production.js >> %LOG% 2>&1

echo. >> %LOG%
echo --- validate-cross-training.js --- >> %LOG%
node scripts\validate-cross-training.js >> %LOG% 2>&1

echo. >> %LOG%
echo ===== END %date% %time% ===== >> %LOG%
