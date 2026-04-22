# Task Scheduler definitions

XML exports of the Windows Task Scheduler tasks that run the automation scripts in this repo.

| Task | File | Schedule | Runs |
| --- | --- | --- | --- |
| HTW Daily Rollups | `HTW-Daily-Rollups.xml` | Daily at 6:00 AM | `run-daily-rollups.bat` |
| HTW Production Scheduler | `HTW-Production-Scheduler.xml` | Every 15 min | `run-scheduler.bat` |

## Re-importing on a new machine

From an elevated command prompt (Run as administrator):

```
schtasks /create /xml task-scheduler\HTW-Daily-Rollups.xml /tn "HTW Daily Rollups"
schtasks /create /xml task-scheduler\HTW-Production-Scheduler.xml /tn "HTW Production Scheduler"
```

### If import fails with "The task XML contains a value which is incorrectly formatted or out of range"

The `<UserId>` element contains a SID tied to the original machine. Either:

1. Edit the XML and replace the `<UserId>` value with the target machine's username (e.g., `DOMAIN\username` or just `username`), then re-run the command above, or
2. Pass `/ru` and `/rp` to override the user at import time:

```
schtasks /create /xml task-scheduler\HTW-Daily-Rollups.xml /tn "HTW Daily Rollups" /ru <username> /rp <password>
```

## Prerequisites on the target machine

- Repo cloned to `C:\Users\chris\Harris-Tools` (the batch files and XML use this absolute path). If the clone location differs, edit the `<Command>` and `<WorkingDirectory>` elements in each XML before import, and update the `cd /d` line in the `.bat` files.
- Node.js installed and on PATH.
- `.token` file present at the repo root containing the Monday.com API token.
- `logs/` directory at the repo root (the batch files write there).

## Re-exporting after changes

If you edit a task in the Task Scheduler UI, re-export it with PowerShell:

```
schtasks /query /tn "HTW Daily Rollups" /xml | Out-File -FilePath task-scheduler\HTW-Daily-Rollups.xml -Encoding utf8
schtasks /query /tn "HTW Production Scheduler" /xml | Out-File -FilePath task-scheduler\HTW-Production-Scheduler.xml -Encoding utf8
```
