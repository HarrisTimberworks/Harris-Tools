@echo off
REM HTW Planner — Saturday (Phase 3). Fires Saturday 18:00 local via Task
REM Scheduler. Runs the full planner unconditionally (fresh plan + Capacity
REM View + Weekly Briefing for Monday morning), regardless of trigger status.
REM See docs\phase-3-manual-overrides-plan.md.

cd /d C:\Users\chris\Harris-Tools
for /f "delims=" %%i in (C:\Users\chris\Harris-Tools\.token) do set MONDAY_API_TOKEN=%%i
set LOG=C:\Users\chris\Harris-Tools\logs\planner-%date:~-4%-%date:~4,2%-%date:~7,2%.log

echo ===== SCHEDULED RUN START %date% %time% ===== >> %LOG%
node scripts\planner-trigger.js --scheduled >> %LOG% 2>&1
echo ===== SCHEDULED RUN END %date% %time% ===== >> %LOG%
