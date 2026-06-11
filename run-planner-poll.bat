@echo off
REM HTW Planner — Poll (Phase 3). Fires every 1 minute via Task Scheduler.
REM Runs the planner ONLY when the trigger item's Status is "Run Requested"
REM (item on the Manual Overrides board; see config\planner-trigger.json).
REM Quiet no-op otherwise. See docs\phase-3-manual-overrides-plan.md.

cd /d C:\Users\chris\Harris-Tools
for /f "delims=" %%i in (C:\Users\chris\Harris-Tools\.token) do set MONDAY_API_TOKEN=%%i
set LOG=C:\Users\chris\Harris-Tools\logs\planner-%date:~-4%-%date:~4,2%-%date:~7,2%.log

node scripts\planner-trigger.js --poll >> %LOG% 2>&1
