@echo off
REM HTW Planner — Saturday (Phase 3). Fires Saturday 18:00 local via Task
REM Scheduler. Runs the full planner unconditionally (fresh plan + Capacity
REM View + Weekly Briefing for Monday morning), regardless of trigger status.
REM See docs\phase-3-manual-overrides-plan.md.

cd /d C:\Users\chris\Harris-Tools
for /f "delims=" %%i in (C:\Users\chris\Harris-Tools\.token) do set MONDAY_API_TOKEN=%%i
REM Locale-independent date (the %%date%% substring trick breaks if Windows
REM regional short-date format ever changes — review finding 2026-06-11).
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set LOG=C:\Users\chris\Harris-Tools\logs\planner-%TODAY%.log

echo ===== SCHEDULED RUN START %date% %time% ===== >> %LOG%
node scripts\planner-trigger.js --scheduled >> %LOG% 2>&1
echo ===== SCHEDULED RUN END %date% %time% ===== >> %LOG%
