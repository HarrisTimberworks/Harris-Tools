@echo off
REM HTW Planner — Poll (Phase 3). Fires every 1 minute via Task Scheduler.
REM Runs the planner ONLY when the trigger item's Status is "Run Requested"
REM (item on the Manual Overrides board; see config\planner-trigger.json).
REM Quiet no-op otherwise. See docs\phase-3-manual-overrides-plan.md.

cd /d C:\Users\chris\Harris-Tools
for /f "delims=" %%i in (C:\Users\chris\Harris-Tools\.token) do set MONDAY_API_TOKEN=%%i
REM Locale-independent date (the %%date%% substring trick breaks if Windows
REM regional short-date format ever changes — review finding 2026-06-11).
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set LOG=C:\Users\chris\Harris-Tools\logs\planner-%TODAY%.log

node scripts\planner-trigger.js --poll >> %LOG% 2>&1
