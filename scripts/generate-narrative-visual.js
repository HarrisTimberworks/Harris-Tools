#!/usr/bin/env node
// Generate the narrative-style HTML schedule visual (dark theme, week-by-week tables)
// in the style of htw-schedule-2026-05-02.html.
//
// Reads logs/rebalance-plan-YYYY-MM-DD.json (most recent) and config/rebalance-overrides.json.
// Writes two files to G:\Shared drives\Harris Timberworks\Production Scheduling\Schedule Visuals\:
//   - htw-schedule-latest.html
//   - htw-schedule-YYYY-MM-DD.html
//
// Usage: node scripts/generate-narrative-visual.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const OVERRIDES_PATH = path.join(REPO_ROOT, 'config', 'rebalance-overrides.json');
const OUT_DIR = 'G:/Shared drives/Harris Timberworks/Production Scheduling/Schedule Visuals';

const CREW_ORDER = ['Chris', 'Jonathan', 'Ken', 'Spencer', 'Bob', 'Ian', 'Paisios', 'Rob'];

// Find the most-recent plan JSON
const planFiles = fs.readdirSync(LOGS_DIR)
  .filter(f => /^rebalance-plan-\d{4}-\d{2}-\d{2}\.json$/.test(f))  // AUDIT FIX 2026-06-11: strict date pattern
  .sort();
if (planFiles.length === 0) { throw new Error('No plan JSON found in logs/'); }
const planFile = planFiles[planFiles.length - 1];
const planDate = planFile.match(/rebalance-plan-(\d{4}-\d{2}-\d{2})\.json/)[1];
const plan = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, planFile), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));

// Per-week finish-cycle event captions for the deployed plan
// (Hand-curated since A5 produces some ghost dates that aren't operationally meaningful.)
const FINISH_BANNERS = {
  '2026-05-18': '🎨 Edge Optics close-out Mon 5/18 (16h Bench, Bob + Jonathan) · BCH non-CU partial delivery Wed 5/20 · BCH CU Finish Drop Wed 5/20 PM · Gilbert pickup from Clay (already at finish) → delivery Fri 5/22 · Westridge pickup from Clay',
  '2026-05-25': '🎨 SHI Finish Drop Wed 5/27 · Quince + Liz Stapp Finish Drop Fri 5/29 · BCH CU Return Tue 5/26 → delivery Wed 5/27 · Westridge delivery Thu 5/28 (Bob PostFin) · Memorial Day Mon (4-day work week)',
  '2026-06-01': '🎨 SHI + Liz Stapp Drop Mon 6/01 (4-day cycle) · Quince finishing continues (5-day cycle, Mon-Fri 6/01-6/05) · SciTech countertop install Tue 6/02 (Bob jobsite)',
  '2026-06-08': '🎨 Quince Return Fri 6/05 → Quince Post-Fin wk 6/08 → delivery Fri 6/12 · McMorris Drop Mon 6/08 (10-day cycle starts) · SHI + Liz Stapp Return Thu 6/04 → Post-Fin → delivery Mon 6/08 · Door + drawer box delivery for McMorris Mon 6/01',
  '2026-06-15': '🎨 McMorris finishing continues (Drop 6/08, Return 6/22) · R5-P2 CU PostFin wk 6/15',
  '2026-06-22': '🎨 McMorris Return Mon 6/22 → Post-Fin Tue-Thu 6/23-6/25 → delivery Fri 6/26',
  '2026-07-20': '🎨 MAG Atom Computing tail (P-Lam, no finish, delivery Sat 8/08)',
  '2026-07-27': '',
  '2026-08-03': '',
};

const FOOTER_NOTES = {
  '2026-05-18': '⚠️ Ken at 41.9h (1.9h OT accepted; BCH 8h + R5-P1 33.9h panel). Bob fully utilized: Edge Optics Mon → BCH PostFin Tue/Wed AM → R5-P1 PostFin Wed PM-Fri. Ian pulled in for 20h production (rest field/jobsite).',
  '2026-05-25': '⚠️ Memorial Day Mon = 32h cap for all. Spencer exactly at 32h (Quince + Liz Stapp + SHI + McMorris remainder). Bob 33.6h slight OT covering R5-P1 + Westridge + BCH CU install + SciTech panel help. Ian PTO 5/25-5/29.',
  '2026-06-01': 'Light week relative to 5/25. Bob 23h on R5-P2 CU Bench (Chris preference: Bob ahead of Spencer). Ian back from PTO, 40h on R5-P2 CU bench. McMorris doors arrive Mon 6/01.',
  '2026-06-08': 'Quince delivers Fri 6/12. SHI + Liz Stapp deliver Mon 6/08. Bob + Ian continuing R5-P2 CU bench. McMorris drop Mon (10 finishing days).',
  '2026-06-15': 'R5-P2 CU finishes (Post-Fin). Light week otherwise — McMorris is at Clay.',
  '2026-06-22': 'McMorris delivers Fri 6/26. Last in-flight residential job before Atom tail.',
  '2026-07-20': 'Atom Computing only. P-Lam, no finishing.',
};

// Build lookup: weekDate -> array of placements
const placementsByWeek = {};
for (const p of plan.placements) {
  if (!placementsByWeek[p.week]) placementsByWeek[p.week] = [];
  placementsByWeek[p.week].push(p);
}

// Build lookup: week -> { crew -> avail }
const grid = plan.capacityGrid;

// Sub names from override file (any week)
const subNames = new Set();
for (const wk of Object.keys(overrides.subcontractors || {})) {
  for (const sub of overrides.subcontractors[wk]) {
    subNames.add(sub.name);
  }
}

// Force lookup: (crew, jobId, week) -> reason
const forceLookup = {};
for (const f of overrides.forceAssignments || []) {
  const key = `${f.crew}|${f.jobId}|${f.week}`;
  forceLookup[key] = f.reason || 'forced';
}

// Crew capacity overrides: (crew, week) -> { available, reason }
const capOverrides = {};
for (const wk of Object.keys(overrides.crewCapacityOverrides || {})) {
  const wkObj = overrides.crewCapacityOverrides[wk];
  for (const crew of Object.keys(wkObj)) {
    capOverrides[`${crew}|${wk}`] = wkObj[crew];
  }
}

function fmtHrs(n) { return (Math.round(n * 100) / 100).toString().replace(/\.0$/, ''); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function shortStation(s) {
  return s
    .replace('Engineering', 'Eng')
    .replace('Panel Processing', 'Panel')
    .replace('Pre Fin Cab Assembly', 'Pre-Fin')
    .replace('Post Fin Cab Assembly', 'Post-Fin')
    .replace('Pack & Ship', 'Pack & Ship')
    .replace('Delivery', 'Delivery');
}

function shortJobName(name) {
  // Drop verbose prefixes if any.
  return name
    .replace('MAG - Roster 5 — Custom Units (P2)', 'MAG R5-P2 (CU)')
    .replace('MAG - Roster 5 — Frameless (P1)', 'MAG R5-P1 (Frameless)')
    .replace('MAG - ', 'MAG ')
    .replace('F&B - ', 'F&B ')
    .replace('MAP - ', 'MAP ')
    .replace('SH - ', 'SH ')
    .replace('SHI - ', 'SHI ')
    .replace('VV - ', 'VV ')
    .replace('NC - ', 'NC ')
    .replace('Liz Stapp - Laundry Room', 'Liz Stapp')
    .replace('Gilbert - Dining Room & Range Hood', 'Gilbert')
    .replace('SHI Huntington Hills', 'SHI Huntington')
    .replace('MAG Roster 5 — Frameless (P1)', 'MAG R5-P1 (Frameless)')
    .replace('MAG Roster 5 — Custom Units (P2)', 'MAG R5-P2 (CU)');
}

function loadCellClass(committed, avail) {
  if (avail === 0) return 'pto';
  const pct = (committed / avail) * 100;
  if (pct > 100) return 'over';
  if (pct > 90) return 'warn';
  return '';
}

function loadCellMarker(committed, avail) {
  if (avail === 0) return '';
  const pct = (committed / avail) * 100;
  if (pct > 100) return ' <span class="marker over">🚨</span>';
  if (pct > 90) return ' <span class="marker warn">🟡</span>';
  return '';
}

function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00Z');
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
}

function renderWeekBlock(weekDate, placements) {
  // Group placements by crew
  const byCrew = {};
  for (const p of placements) {
    if (!byCrew[p.crew]) byCrew[p.crew] = [];
    byCrew[p.crew].push(p);
  }

  // Total hours for header
  const totalHrs = placements.reduce((s, p) => s + p.hours, 0);

  // Crew sort: standard order, then any subs (alphabetical)
  const crewsPresent = Object.keys(byCrew);
  const orderedCrews = [];
  for (const c of CREW_ORDER) {
    if (crewsPresent.includes(c)) orderedCrews.push(c);
  }
  for (const c of crewsPresent.sort()) {
    if (!CREW_ORDER.includes(c) && !orderedCrews.includes(c)) orderedCrews.push(c);
  }

  // Also include PTO crews (capacity override = 0) even with no placements
  for (const ckey of Object.keys(capOverrides)) {
    const [crew, wk] = ckey.split('|');
    if (wk === weekDate && capOverrides[ckey].available === 0 && !orderedCrews.includes(crew)) {
      orderedCrews.push(crew);
    }
  }

  const finishBanner = FINISH_BANNERS[weekDate];
  const footerNote = FOOTER_NOTES[weekDate];

  let html = `<div class="week-block">\n`;
  html += `  <div class="week-header">Week of ${fmtDate(weekDate)} — ${fmtHrs(totalHrs)} crew hrs</div>\n`;
  if (finishBanner) html += `  <div class="finish-banner">${finishBanner}</div>\n`;
  html += `  <table>\n`;
  html += `    <tr>\n      <th style="width: 18%">Crew</th>\n      <th style="width: 16%">Load</th>\n      <th style="width: 32%">Job</th>\n      <th style="width: 22%">Station</th>\n      <th style="width: 12%">Hrs</th>\n    </tr>\n`;

  for (const crew of orderedCrews) {
    const capInfo = grid[crew]?.[weekDate] || { avail: 40, committed: 0, over: 0 };
    const avail = capInfo.avail;
    const committed = capInfo.committed;
    const cls = loadCellClass(committed, avail);
    const marker = loadCellMarker(committed, avail);
    const isSub = subNames.has(crew) || /sub/i.test(crew);
    const rowClass = `crew-start${isSub ? ' sub-row' : ''}`;

    const overrideForCrew = capOverrides[`${crew}|${weekDate}`];
    const isPTO = avail === 0 || (overrideForCrew && overrideForCrew.available === 0);

    if (isPTO) {
      const reason = overrideForCrew?.reason || 'out';
      html += `    <tr class="${rowClass}"><td class="crew-name">${crew}</td><td class="load pto">— ${escapeHtml(reason)}</td><td colspan="3" class="pto">— no production placements</td></tr>\n`;
      continue;
    }

    const places = byCrew[crew] || [];
    if (places.length === 0) {
      html += `    <tr class="${rowClass}"><td class="crew-name">${crew}</td><td class="load">${fmtHrs(committed)} / ${avail}</td><td colspan="3" class="pto">— no placements</td></tr>\n`;
      continue;
    }

    // Sort placements within a crew by station priority then job
    places.sort((a, b) => a.station.localeCompare(b.station) || a.jobName.localeCompare(b.jobName));

    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const isFirst = i === 0;
      const job = shortJobName(p.jobName);
      const station = shortStation(p.station);
      const forceKey = `${crew}|${p.jobId}|${weekDate}`;
      const forced = forceLookup[forceKey] || p.forced;
      const forcedMarker = forced ? ` <span class="forced">forced</span>` : '';

      if (isFirst) {
        html += `    <tr class="${rowClass}"><td class="crew-name">${crew}</td><td class="load ${cls}">${fmtHrs(committed)} / ${avail}${marker}</td><td>${escapeHtml(job)}</td><td>${escapeHtml(station)}${forcedMarker}</td><td>${fmtHrs(p.hours)}</td></tr>\n`;
      } else {
        html += `    <tr><td></td><td></td><td>${escapeHtml(job)}</td><td>${escapeHtml(station)}${forcedMarker}</td><td>${fmtHrs(p.hours)}</td></tr>\n`;
      }
    }
  }

  html += `  </table>\n`;
  if (footerNote) html += `  <div class="footer-note">${footerNote}</div>\n`;
  html += `</div>\n`;
  return html;
}

const sortedWeeks = Object.keys(placementsByWeek).sort();
const weekBlocks = sortedWeeks.map(w => renderWeekBlock(w, placementsByWeek[w])).join('\n');

const HEADER = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>HTW Production Schedule — Week-of-5/18 Deploy (v11)</title>
<style>
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    background: #1a1a1a;
    color: #e8e8e8;
    margin: 0;
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { font-size: 22px; margin-bottom: 8px; color: #f0f0f0; }
  .summary { color: #999; font-size: 13px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #333; }
  .week-block { margin-bottom: 32px; page-break-inside: avoid; }
  .week-header { font-size: 18px; font-weight: bold; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #333; }
  .finish-banner { background: #2a3a2a; color: #c8e0c8; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 12px; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { text-align: left; padding: 10px 12px; font-weight: 600; color: #c0c0c0; font-size: 13px; border-bottom: 1px solid #333; }
  td { padding: 10px 12px; border-bottom: 1px solid #2a2a2a; font-size: 14px; }
  tr.crew-start td { border-top: 1px solid #444; }
  td.crew-name { font-weight: 500; }
  td.load { color: #b0b0b0; font-family: 'Courier New', monospace; font-size: 13px; }
  td.load.warn { color: #ffa500; }
  td.load.over { color: #ff4d4d; font-weight: bold; }
  td.load.pto { color: #888; font-style: italic; }
  .marker { display: inline-block; margin-left: 6px; font-size: 11px; }
  .marker.over { color: #ff4d4d; }
  .marker.warn { color: #ffa500; }
  .pto { color: #888; font-style: italic; }
  .forced { color: #6b9bd1; font-size: 11px; margin-left: 6px; }
  .sub-row td { color: #b8b8d8; }
  .footer-note { font-size: 12px; color: #888; margin-top: 16px; padding-top: 12px; border-top: 1px dashed #333; }
  .legend { display: flex; gap: 16px; margin-bottom: 24px; font-size: 12px; color: #999; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .changes-banner { background: #2a3a4a; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px; font-size: 13px; color: #d0e0f0; }
  .changes-banner strong { color: #f0f0f0; }
  .delivery-shifts { background: #3a3328; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px; font-size: 13px; color: #f0e0c0; }
</style>
</head>
<body>

<h1>HTW Production Schedule — Week of 5/18 Deploy (v11)</h1>
<div class="summary">
  ${plan.totalPlacements} placements · ${plan.jobsScheduled} jobs scheduled · Plan covers 5/18 → 8/03 · ${plan.warnings.length} warnings · Generated ${new Date(plan.generatedAt).toLocaleString()}
</div>

<div class="changes-banner">
  <strong>What changed from iter 8 → v11:</strong> Week-of-5/11 passed off-script (no deployed schedule). 12 jobs reconciled with current state. customWindow conventions normalized to Monday-anchored starts (placement loop key). R5-P2 CU Phase 1 release (panel 22 / bench 126 / postfin 16 from formula totals). BCH split delivery (5/20 non-CU partial + 5/27 CU final). Ian pulled in for 20h production wk 5/18 (rest field work). Paisios returns from paternity at half-time. Memorial Day Mon 5/25 capacity adjustments.
</div>

<div class="delivery-shifts">
  <strong>Master PM delivery dates updated (8 pushes):</strong><br>
  · MAG BCH: Wed 5/20 → <strong>Wed 5/27</strong> (CU split; non-CU 5/20 partial is operational)<br>
  · F&B Quince Ave: Fri 5/29 → <strong>Fri 6/12</strong> (push 2 weeks)<br>
  · Liz Stapp - Laundry Room: Wed 6/03 → <strong>Mon 6/08</strong> (planner cascade math)<br>
  · SHI Huntington Hills: Wed 6/03 → <strong>Mon 6/08</strong> (planner cascade math; drops with Liz Stapp)<br>
  · SH McMorris: Fri 6/19 → <strong>Fri 6/26</strong> (door + drawer box 2-week lead)<br>
  · MAG SciTech: Mon 5/25 → <strong>Tue 6/02</strong> (Memorial Day conflict resolved)<br>
  · F&B Westridge Office: Fri 5/08 → <strong>Thu 5/28</strong> (GC turbulence, target date)<br>
  · MAG R5-P2 CU: → <strong>Thu 6/18</strong> placeholder (change orders pending, will revise)
</div>

<div class="legend">
  <div class="legend-item"><span class="marker over">🚨</span> Over capacity</div>
  <div class="legend-item"><span class="marker warn">🟡</span> Near/at cap (&gt;90%)</div>
  <div class="legend-item"><span class="forced">forced</span> Pinned via override</div>
  <div class="legend-item"><span class="sub-row" style="color:#b8b8d8">sub</span> Subcontractor</div>
</div>

`;

const FOOTER = `
<div class="footer-note" style="margin-top: 32px; font-size: 13px; padding: 16px; background: #2a2a2a; border-radius: 4px;">
  <strong>Capacity heat (this deploy):</strong><br>
  · Ken wk 5/18 = 41.9h on 40h cap (1.9h OT — BCH Panel 8h + R5-P1 Panel 33.9h)<br>
  · Spencer wk 5/25 = exactly 32h on 32h Memorial-Day-shrunk cap (zero slack)<br>
  · Spencer + Bob wk 5/25 may trip 33.6/32 if any new urgency lands<br>
  · Ian wk 5/18 capped at 20h production (rest field/jobsite work)<br>
  · Ian PTO 5/25-5/29<br>
  <br>
  <strong>Finishing cycle integrity (FCV all pass):</strong><br>
  · Quince: Pre-Fin wk 5/25 → Drop Fri 5/29 → Return Fri 6/05 → Post-Fin wk 6/08 → Deliver Fri 6/12 ✓<br>
  · Liz Stapp: Pre-Fin wk 5/25 → Drop Mon 6/01 → Return Thu 6/04 → Post-Fin → Deliver Mon 6/08 ✓<br>
  · SHI Huntington Hills: same as Liz Stapp (Drop Mon 6/01, Return Thu 6/04, Deliver Mon 6/08) ✓<br>
  · McMorris: Pre-Fin wks 5/18 + 5/25 + 6/01 → Drop Mon 6/08 → Return Mon 6/22 (10 BD) → Post-Fin → Deliver Fri 6/26 ✓<br>
  · Gilbert + Westridge: already at Clay, Bob picks up wk 5/18 (Gilbert Fri 5/22, Westridge Thu 5/28)<br>
  · BCH (split delivery): non-CU 5/20 partial via PostFin Tue/Wed; CU portion Drop Wed 5/20 PM, Return Tue 5/26, Deliver Wed 5/27 — operational, not in finishing-cycle model (pLam=true on PLB)<br>
  · Edge Optics, R5-P1, R5-P2 CU, SciTech, Atom: P-Lam, no Clay finishing cycle<br>
  <br>
  <strong>Subcontractor allocation:</strong><br>
  · R5-P1-PostFin-sub 24h on wk 5/25 — allocated, fallbackOnly (Bob absorbs unless capped)<br>
  · No other subs locked this rebalance<br>
  <br>
  <strong>On hold:</strong> VV Wrangler Way (pending site measurements; not in plan).
</div>

</body>
</html>
`;

const html = HEADER + weekBlocks + FOOTER;

// Write files
const datedPath = path.join(OUT_DIR, `htw-schedule-${planDate}.html`);
const latestPath = path.join(OUT_DIR, 'htw-schedule-latest.html');
fs.writeFileSync(datedPath, html);
fs.writeFileSync(latestPath, html);

console.log(`Generated narrative-style visual from logs/${planFile}`);
console.log(`  → ${datedPath} (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  → ${latestPath}`);
console.log(`  weeks rendered: ${sortedWeeks.length}, placements: ${plan.totalPlacements}`);
