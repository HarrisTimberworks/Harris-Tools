---
name: harris-drive
description: "Quick reference for Harris Timberworks Google Drive folders and how to read files stored there. Use this skill whenever the user asks to look up, search, navigate, or read anything in their Google Drive — especially when they mention Bid Files, Current Jobs, the Harris Timberworks Shared Drive, or ask to read/pull a PDF, plan set, takeoff, proposal, or spreadsheet stored in Drive. Also trigger when the user says things like 'check Drive', 'find in Drive', 'look in our files', or references project/job folders by name."
---

# Harris Timberworks — Google Drive Reference

Chris and the Harris Timberworks team use a Google Shared Drive as their primary file system for business operations. This skill gives you the folder structure and — critically — which of the two access paths to use.

## FIRST: Pick the Right Access Path

There are two doors into the Drive. Past sessions repeatedly failed by using the wrong one — the cloud connector **cannot read PDFs or binary files**.

**Quick rule:** read any file content → `G:\` mount (Path 1). Cloud full-text search, or reading/**creating** native Google Docs/Sheets → connector (Path 2). When unsure, use the mount.

### Path 1 — Local mount (PREFERRED for reading any file content)

On Chris's desktop, the entire Shared Drive is mounted at:

```
G:\Shared drives\Harris Timberworks
```

via Google Drive for Desktop. Use normal file tools (Glob, Read, PowerShell, Python) on these paths. This is the **only** reliable way to read PDFs, plan sets, CSVs, xlsx, and .btx files.

- **Availability check:** `Test-Path "G:\Shared drives\Harris Timberworks"` — if true, use this path for all file content.
- **Key paths:**
  - `G:\Shared drives\Harris Timberworks\1. Bid Files`
  - `G:\Shared drives\Harris Timberworks\2. Current Jobs`
  - `G:\Shared drives\Harris Timberworks\BlueBeam Templates & Config` (shared Revu tool sets / .btx files)
- **Reading PDFs:** the native Read tool may fail on this machine (`pdftoppm` missing) — extract text via Python with `pypdf` (installed; `pdfplumber` is NOT installed).
- Files stream on demand: a large plan set takes a few seconds on first read. Metadata listing (Glob/dir) is fast.

### Path 2 — Cloud connector (search, native Docs/Sheets, and WRITES)

The Drive connector is a separate MCP exposing generic "files" tools. Load them via ToolSearch (query `google drive`); the ones you'll use:
- `search_files` — cloud-side search. Query syntax: `title contains '…'`, `fullText contains '…'`, `parentId = '<folder id>'`, `mimeType contains '…'`, combined with `and`/`or`/`not`. **Not** `name contains` or `'<id>' in parents` — this connector silently rejects that Drive-API syntax.
- `read_file_content` — natural-language read of a native Doc/Sheet (smaller, easier to parse than a raw download).
- `download_file_content` — raw bytes of a native file (base64; `exportMimeType` required for Google types).
- `create_file` — create a native Sheet/Doc/folder or upload a file into a Drive folder (see **Writing to Drive** below).

**Use the connector ONLY for these three jobs:**
1. Cloud full-text search across the Drive (`fullText contains '…'`).
2. Reading **native Google Docs/Sheets** content.
3. **Writing** — creating native Sheets/Docs/folders or uploading into a Drive folder.

For everything else — and ALWAYS for PDFs, CSVs, xlsx, .btx, and other binaries — use the `G:\` mount (Path 1); the connector **cannot read them**. If a PDF is needed and no `G:\` mount exists (e.g., claude.ai mobile), ask the user to attach the file or move the task to a desktop session. If none of the three jobs apply, the connector can stay disconnected.

## Shared Drive Structure

The Harris Timberworks Shared Drive root ID is `0AKdQof3SWg8vUk9PVA`.

Two folders are used constantly:

### 1. Bid Files
- **Folder ID:** `14e68zovNwg9fybCncYMGtdPnGYFKbd2q`
- **Path:** Shared Drive > Harris Timberworks > 1. Bid Files
- **Local mount path:** `G:\Shared drives\Harris Timberworks\1. Bid Files`
- **Purpose:** Bid-stage estimates, plans, and documents. **Top-level folders are CLIENT names; projects nest beneath them** (e.g. `1. Bid Files\Springhaus\Old Timnath Estates`) — always search recursively, a top-level name filter will miss projects.
- **Standard project folder layout:** `Architectural Drawings`, `Client Facing\Proposal`, `Client Facing\Submittal Drawings`, `BB Estimating`, `Shop Facing\Materials`, `Shop Facing\Kit List` — proposals live in `Client Facing\Proposal`.
- **To search within it (connector):**
  ```
  parentId = '14e68zovNwg9fybCncYMGtdPnGYFKbd2q'
  ```
- **To search recursively (by title or content):**
  ```
  fullText contains '<search term>'
  ```
  then filter results whose parent chain includes this folder. (`parentId =` matches direct children only — use `fullText`/`title contains` to reach nested projects.)

### 2. Current Jobs
- **Folder ID:** `17rwUbdLQsc_dgIX-fG78782JvwXdx0eM`
- **Path:** Shared Drive > Harris Timberworks > 2. Current Jobs
- **Local mount path:** `G:\Shared drives\Harris Timberworks\2. Current Jobs`
- **Purpose:** Contains subfolders for active/in-progress jobs. Once a bid is won, the job moves here. This is where contracts, schedules, change orders, and job-stage documents live.
- **To search within it (connector):**
  ```
  parentId = '17rwUbdLQsc_dgIX-fG78782JvwXdx0eM'
  ```

## Writing to Drive (native Sheets/Docs — connector only)

The `G:\` mount can only sync existing files — it **cannot create a native Google Sheet/Doc** (dropping an `.xlsx` there just syncs an uploaded `.xlsx`, not a native Sheet). To deliver a native file into a job folder, use the connector's `create_file` with `parentId` = the target folder's ID (the IDs above):

- **CSV → native Google Sheet** (the common case — e.g. takeoff/proposal delivery): `create_file` with `textContent` = the CSV text, `contentMimeType = 'text/csv'`, `parentId` = job folder. The connector auto-converts `text/csv` → Sheet and `text/plain` → Doc. To upload as a plain `.csv`/`.xlsx` with no conversion, add `disableConversionToGoogleType: true`.
- **Empty native file:** create with a Google mime type and no content — `application/vnd.google-apps.spreadsheet` (Sheet), `…document` (Doc), or `…folder` (folder).
- `create_file` returns the new File object — capture its `id` to link or share the result.

## How to Use These References

- **"Find the Canyon Creek bid"** → if G:\ available: `Get-ChildItem "G:\Shared drives\Harris Timberworks\1. Bid Files" -Directory -Recurse -Filter "*Canyon Creek*" | Select-Object -ExpandProperty FullName` (recursive — projects nest under client folders). Otherwise connector: `fullText contains 'Canyon Creek'`, then keep hits whose parent chain runs under the Bid Files folder (use `fullText`/`title contains`, never `name` or `in parents`).
- **"Read the proposal PDF for X"** → local mount + pypdf. Never attempt PDF content through the connector.
- **"What's in the Skyland job folder?"** → list the folder via mount, or connector search `parentId = '17rwUbdLQsc_dgIX-fG78782JvwXdx0eM' and title contains 'Skyland'`, then list contents by ID.
- **"Find any docs mentioning lumber quote"** → connector `fullText contains 'lumber quote'` (content search is the connector's strength), then read the hits via the local mount if they're PDFs.
- **"Deliver the takeoff as a native Sheet in the job folder"** → connector `create_file` with `textContent` = CSV, `contentMimeType = 'text/csv'`, `parentId` = the job's Current Jobs folder ID → auto-creates a native Google Sheet. Don't drop an `.xlsx` on the mount expecting a native Sheet.

If the user doesn't specify Bid Files vs. Current Jobs, search both folders. If a project name isn't found in one, try the other — jobs sometimes haven't been moved yet.
