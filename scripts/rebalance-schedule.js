#!/usr/bin/env node
/**
 * HTW Production Rebalancer
 *
 * Pulls all Production Load jobs, crew allocation parents, and time off,
 * then builds a level-loaded schedule across the planning horizon.
 *
 * Two-phase operation:
 *   --plan     : read-only, outputs proposed changes to console + logs/rebalance-plan-<date>.json
 *   --execute  : reads the latest plan and applies it to monday.com
 *
 * Requires env var: MONDAY_API_TOKEN
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIG
// ============================================================================

const API_URL = 'https://api.monday.com/v2';
const TOKEN = process.env.MONDAY_API_TOKEN;

const MODE = process.argv.includes('--execute') ? 'execute' : 'plan';
const AUTO_CREATE_PARENTS = process.argv.includes('--auto-create-parents');
const FORCE = process.argv.includes('--force');

// ============================================================================
// LOAD OVERRIDES CONFIG
// ============================================================================

const OVERRIDES_PATH = path.join(__dirname, '..', 'config', 'rebalance-overrides.json');
let OVERRIDES = {
  jobOverrides: {},
  crewCapacityOverrides: {},
  subcontractors: {},
  skipJobs: [],
};
if (fs.existsSync(OVERRIDES_PATH)) {
  try {
    OVERRIDES = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    console.log(`Loaded overrides from ${OVERRIDES_PATH}`);
  } catch (e) {
    console.error(`Failed to parse ${OVERRIDES_PATH}: ${e.message}`);
    process.exit(1);
  }
} else {
  console.log(`No overrides file at ${OVERRIDES_PATH} — running with defaults`);
}

// Board IDs
const BOARD_PL = 18407601557;          // Production Load
const BOARD_MASTER_PM = 9820786641;    // Master PM
const BOARD_CREW_ALLOC = 18409529791;  // Weekly Crew Allocation (parents)
const BOARD_CREW_SUBITEMS = 18409530171; // Crew Allocation subitems
const BOARD_TIME_OFF = 18409530322;    // Time Off
const BOARD_OVERRIDES = 18413101550;   // 🛠️ HTW Manual Overrides (Phase 1 B1)

// Column IDs on Production Load Board
const COL_PL = {
  status: 'color_mm26404x',
  subtype: 'color_mm26yes1',
  delivery: 'lookup_mm2n4nf4',      // mirrored from Master PM
  masterPmLink: 'board_relation_mm26mhea',
  eng: 'formula_mm2dpf4n',
  panel: 'formula_mm2dxy2k',
  bench: 'formula_mm2d25dk',
  prefin: 'formula_mm2df4w1',
  postfin: 'formula_mm2d5fmw',
  windowEng: 'week_mm26ywqt',
  windowPanel: 'week_mm26h520',
  windowBench: 'week_mm26v34w',
  windowPrefin: 'week_mm26nywp',
  windowPostfin: 'week_mm26z8fz',
  windowPackShip: 'week_mm26ykzx',
  finishDrop: 'date_mm26qqv3',
  finishReturn: 'date_mm2k17ef',
  finishingDays: 'numeric_mm2hdd1z',
  pLam: 'boolean_mm2f3589',
  productionNotes: 'long_text_mm26686j',
  // 2026-06-11 — shop-floor per-station completion (multi-select dropdown,
  // labels Eng/Panel/Bench/PreFin/PostFin). Board-done beats config beats
  // formula; see computeRemainingHours.
  stationsComplete: 'dropdown_mm48p4zs',
};

// ============================================================================
// Stations-Complete tracking (2026-06-11)
// ============================================================================

const STATION_LABEL_TO_KEY = Object.freeze({
  Eng: 'eng',
  Panel: 'panel',
  Bench: 'bench',
  PreFin: 'prefin',
  PostFin: 'postfin',
});
const STATION_HOUR_KEYS = Object.freeze(['eng', 'panel', 'bench', 'prefin', 'postfin']);

// Per-station precedence: board-done → 0 (ALWAYS wins — the board is live
// shop-floor truth and kills config staleness) → else board ⏳ Hrs Left (a
// non-empty cell is the shop's current remaining estimate, verbatim — may
// exceed the formula on overruns, never clamped; spec 2026-06-12) → else
// config remainingHours → else formula. Unknown labels are ignored.
function computeRemainingHours(formulaHours, overrideRemaining, stationsComplete, hrsLeft) {
  const done = new Set((stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
  const base = overrideRemaining && overrideRemaining !== null ? overrideRemaining : (formulaHours || {});
  const hl = hrsLeft || {};
  const out = {};
  for (const k of STATION_HOUR_KEYS) {
    if (done.has(k)) { out[k] = 0; continue; }
    out[k] = isValidHrsLeft(hl[k]) ? hl[k] : Number(base[k] || 0);
  }
  return out;
}

// A usable ⏳ Hrs Left value: finite number ≥ 0. Anything else (null for an
// empty cell, NaN, negatives) falls through to config/formula;
// shopProgressWarnings surfaces the garbage.
function isValidHrsLeft(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// monday numbers-column text → null (empty cell = "no board info") or a
// number. May return NaN/negative/Infinity for garbage — isValidHrsLeft
// gates use.
function parseHrsLeftCell(text) {
  const t = (text ?? '').trim();
  return t === '' ? null : parseFloat(t.replace(/,/g, ''));
}

// Run-summary warnings for the ⏳ Hrs Left columns (spec 2026-06-12).
// Summary-only: never blocks the run, never triggers a notification.
const PROGRESS_WARN_STATUSES = new Set([
  'Not Started', 'Ready to Schedule', 'Scheduled', 'Finishing', 'Ready to Ship',
]);
const STATION_KEY_TO_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(STATION_LABEL_TO_KEY).map(([l, k]) => [k, l])));

function shopProgressWarnings(jobs) {
  const warnings = [];
  for (const j of jobs || []) {
    if (!PROGRESS_WARN_STATUSES.has(j.status)) continue;
    const done = new Set((j.stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
    const hl = j.hrsLeft || {};
    for (const k of STATION_HOUR_KEYS) {
      const v = hl[k];
      if (v === null || v === undefined) continue;
      const label = STATION_KEY_TO_LABEL[k];
      const f = Number((j.formulaHours || {})[k] || 0);
      if (!isValidHrsLeft(v)) {
        warnings.push(`${j.name} ${label}: invalid ⏳ Hrs Left (${v}) ignored — falls back to tick/config/formula precedence`);
      } else if (done.has(k) && v > 0) {
        warnings.push(`${j.name} ${label}: ticked complete but ⏳ Hrs Left is ${v} — tick wins (0 hrs); clear the cell or untick`);
      } else if (!done.has(k) && v === 0) {
        warnings.push(`${j.name} ${label}: ⏳ Hrs Left is 0 but station not ticked — tick ✅ Stations Complete if truly done`);
      } else if (v > f + 1e-9) {
        warnings.push(`${j.name} ${label}: ⏳ Hrs Left ${v} exceeds formula ${f} — overrun or change order pending (info)`);
      }
    }
  }
  return warnings;
}

// True when EVERY station with formula hours > 0 is marked done. Drives the
// derived "Ready to Ship" status in run-planner.js: production is finished
// but the job stays ACTIVE so P&S/Delivery keep planning (the Liz Stapp
// Complete-cliff fix — flipping straight to Complete dropped jobs while
// delivery work remained). An empty required set → false (nothing to
// complete is not the same as ready).
// 2026-06-12: a station with board ⏳ Hrs Left > 0 also counts as required
// even at formula 0 — board-added work can't be skipped by the RTS flip.
function isReadyToShip(formulaHours, stationsComplete, hrsLeft) {
  const done = new Set((stationsComplete || []).map(l => STATION_LABEL_TO_KEY[l]).filter(Boolean));
  const hl = hrsLeft || {};
  const required = STATION_HOUR_KEYS.filter(k =>
    Number((formulaHours || {})[k] || 0) > 0
    || (isValidHrsLeft(hl[k]) && hl[k] > 0));
  if (required.length === 0) return false;
  return required.every(k => done.has(k));
}

// Column IDs on Crew Allocation parent board
const COL_CA = {
  weekDate: 'date_mm2kjth4',
  crewText: 'text_mm2mhm0y',
  baseHours: 'numeric_mm2kbvse',
  timeOffHours: 'numeric_mm2k57x0',
  nonProdHours: 'numeric_mm2knj6j',
};

// Column IDs on Crew Allocation subitem board
const COL_SUB = {
  station: 'dropdown_mm2kex19',
  relatedJob: 'board_relation_mm2kchhq',
  hours: 'numeric_mm2kv7rq',
  assignedText: 'text_mm2mpjcn',
  person: 'person',
};

// Column IDs on Time Off board
const COL_TO = {
  person: 'multiple_person_mm2kkp12',
  dates: 'timerange_mm2k10v8',
  hours: 'numeric_mm2kkfcj',
  type: 'color_mm2kfmtt',
  status: 'color_mm2kt4fv',
};

// Column IDs on Manual Overrides board. Full reference (including Conflict
// Reason, Reason, Created By, Last Run) lives in docs/htw-cross-training-matrix.md §13;
// B4 only consumes the read-side columns.
const COL_OV = {
  job: 'board_relation_mm3a4yk3',
  station: 'dropdown_mm3avza0',
  fromCrew: 'board_relation_mm3agpw8',
  fromWeek: 'date_mm3adwrw',
  toCrew: 'board_relation_mm3aqb40',
  toWeek: 'date_mm3ack0z',
  hours: 'numeric_mm3ad4na',
  status: 'color_mm3aqx5g',
  allowOverCap: 'boolean_mm3ahx01',
};

// Active group is the working set; Stale is archival (auto-populated by
// monday automations once a row's To Week passes). B4 only reads Active.
const OVERRIDES_GROUP_ACTIVE = 'topics';

// Station dropdown labels → IDs
const STATION_IDS = {
  'Engineering': 1,
  'Panel Processing': 2,
  'Benchwork': 3,
  'Pre Fin Cab Assembly': 4,
  'Post Fin Cab Assembly': 5,
  'Pack & Ship': 6,
  'Delivery': 7,
};

// Crew display name → monday user ID
const CREW_PERSON_ID = {
  Chris: 77398023,
  Jonathan: 78941017,
  Paisios: 77398083,
  Rob: 102500064,
  Ian: 99508397,
  Spencer: 97341714,
  Bob: 100329892,
  Ken: null, // no monday account
};

// Crew base weekly hours (non-Production)
const CREW_BASE_HOURS = {
  Chris: 15,
  Jonathan: 40,
  Paisios: 40,
  Rob: 0,
  Ian: 40,
  Spencer: 40,
  Ken: 40,
  Bob: 40,
};

// Bob doesn't start until this date (as an employee; pre-5/18 he's subcontract-only)
const BOB_START_DATE = '2026-05-18';

// AUDIT FIX (2026-06-12) — crew departure model, symmetric to start dates.
// From a crew's end date: no parent rows demanded (or auto-created), zero
// grid capacity, hard rule already blocks routing (hardRuleViolation).
// Historical weeks before the end date stay fully valid.
const CREW_END_DATES = { Ian: '2026-06-11' };

// Soft capacity ceiling — allow 5% over before flagging as overload
const SOFT_CAP_MULTIPLIER = 1.05;

// ============================================================================
// ROUTING MATRIX — keyed by [Job Subtype][Station] → array of Primary crew
// ============================================================================

// 2026-06-11 — Ian departed (moved to North Carolina). New chains per Chris:
//   PostFin: Bob > Paisios > Spencer > Ken(Commercial-only via hard rule)
//   Bench:   Bob > Spencer > Jonathan
//   PreFin:  Spencer > Bob
// Applied uniformly across subtypes.
const ROUTING = {
  'Res - Face Frame': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Bob'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Res - Frameless': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Bob'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Commercial': {
    'Engineering':            ['Jonathan'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Bob'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Countertop/Surface': {
    'Engineering':            ['Jonathan'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Bob'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Mixed': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Bob'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
};

// ============================================================================
// CROSS-TRAINING MATRIX — Secondary fallbacks when Primary is full
// Format: [subtype][station] → array of crew (ordered by preference)
// ============================================================================

const SECONDARY = {
  'Res - Face Frame': {
    'Benchwork':              ['Spencer', 'Paisios', 'Jonathan'],  // Paisios ramping on bench (2026-06-12, ahead of Jonathan — keep Jonathan free)
    'Pre Fin Cab Assembly':   ['Bob'],  // Ken removed per matrix hard rule
    'Post Fin Cab Assembly':  ['Paisios', 'Spencer'],
    'Engineering':            ['Paisios', 'Jonathan'],
    'Panel Processing':       ['Bob'],
    'Pack & Ship':            ['Spencer', 'Bob', 'Jonathan'],
    'Delivery':               ['Spencer', 'Bob', 'Jonathan'],
  },
  'Res - Frameless': {
    'Benchwork':              ['Spencer', 'Paisios', 'Jonathan'],  // Paisios ramping on bench (2026-06-12, ahead of Jonathan — keep Jonathan free)
    'Pre Fin Cab Assembly':   ['Bob'],  // Ken removed per matrix hard rule
    'Post Fin Cab Assembly':  ['Paisios', 'Spencer'],
    'Panel Processing':       ['Bob'],
    'Engineering':            ['Paisios', 'Jonathan', 'Rob'],  // Rob = fill-only tertiary per doc §7 priority ladder
    'Pack & Ship':            ['Spencer', 'Bob', 'Jonathan'],
    'Delivery':               ['Spencer', 'Bob', 'Jonathan'],
  },
  'Commercial': {
    'Benchwork':              ['Spencer', 'Paisios', 'Jonathan'],  // Paisios ramping on bench (2026-06-12, ahead of Jonathan — keep Jonathan free)
    'Pre Fin Cab Assembly':   ['Bob'],
    'Post Fin Cab Assembly':  ['Paisios', 'Spencer', 'Ken'],  // Ken OK for commercial PostFin
    'Panel Processing':       ['Bob'],
    'Pack & Ship':            ['Spencer', 'Bob', 'Jonathan'],
    'Delivery':               ['Spencer', 'Bob', 'Jonathan'],
  },
  'Countertop/Surface': {
    'Benchwork':              ['Spencer', 'Paisios', 'Jonathan'],  // Paisios ramping on bench (2026-06-12, ahead of Jonathan — keep Jonathan free)
    'Pre Fin Cab Assembly':   ['Bob'],
    'Post Fin Cab Assembly':  ['Paisios', 'Spencer'],
    'Panel Processing':       ['Bob'],
    'Pack & Ship':            ['Spencer', 'Bob', 'Jonathan'],
    'Delivery':               ['Spencer', 'Bob', 'Jonathan'],
  },
  'Mixed': {
    'Benchwork':              ['Spencer', 'Paisios', 'Jonathan'],  // Paisios ramping on bench (2026-06-12, ahead of Jonathan — keep Jonathan free)
    'Pre Fin Cab Assembly':   ['Bob'],  // Ken removed per matrix hard rule
    'Post Fin Cab Assembly':  ['Paisios', 'Spencer'],
    'Engineering':            ['Paisios', 'Jonathan'],
    'Pack & Ship':            ['Spencer', 'Bob', 'Jonathan'],
    'Delivery':               ['Spencer', 'Bob', 'Jonathan'],
  },
};

// ============================================================================
// GraphQL helper
// ============================================================================

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL error:', JSON.stringify(data.errors, null, 2));
    throw new Error('GraphQL call failed');
  }
  return data.data;
}

// ============================================================================
// Date helpers
// ============================================================================

function toISO(d) { return d.toISOString().slice(0, 10); }
function parseISO(s) { return new Date(s + 'T00:00:00Z'); }

function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function businessDaysBack(dateStr, days) {
  let d = parseISO(dateStr);
  let remaining = days;
  while (remaining > 0) {
    d = addDays(d, -1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return toISO(d);
}

// Forward counterpart: advance N weekdays (skip Sat/Sun) from startDate
function addBusinessDays(dateStr, days) {
  let d = parseISO(dateStr);
  let remaining = days;
  while (remaining > 0) {
    d = addDays(d, 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return toISO(d);
}

// Get array of Monday dates in the planning window
function getWeekList(startISO, endISO) {
  const weeks = [];
  let d = getMondayOfWeek(parseISO(startISO));
  const end = parseISO(endISO);
  while (d <= end) {
    weeks.push(toISO(d));
    d = addDays(d, 7);
  }
  return weeks;
}

// ============================================================================
// DATA LOADERS
// ============================================================================

async function loadJobs(gqlFn = gql) {
  const q = `query {
    boards(ids: [${BOARD_PL}]) {
      items_page(limit: 100) {
        items {
          id
          name
          column_values {
            id
            text
            value
            ... on FormulaValue { display_value }
            ... on MirrorValue { display_value }
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }
    }
  }`;
  const data = await gqlFn(q);
  const items = data.boards[0].items_page.items;

  return items.map(it => {
    const cv = {};
    for (const v of it.column_values) cv[v.id] = v;
    const pLamChecked = cv[COL_PL.pLam]?.value && JSON.parse(cv[COL_PL.pLam].value).checked;

    // Apply job overrides from config
    const override = OVERRIDES.jobOverrides?.[it.id] || {};

    const formulaHours = {
      eng: parseFloat(cv[COL_PL.eng]?.display_value || '0'),
      panel: parseFloat(cv[COL_PL.panel]?.display_value || '0'),
      bench: parseFloat(cv[COL_PL.bench]?.display_value || '0'),
      prefin: parseFloat(cv[COL_PL.prefin]?.display_value || '0'),
      postfin: parseFloat(cv[COL_PL.postfin]?.display_value || '0'),
    };

    // Stations-Complete (2026-06-11): dropdown text is comma-separated
    // labels ("Eng, Panel"). Board-done stations zero out regardless of
    // override/formula — see computeRemainingHours.
    const stationsComplete = (cv[COL_PL.stationsComplete]?.text || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const hours = computeRemainingHours(formulaHours, override.remainingHours || null, stationsComplete);

    return {
      id: it.id,
      name: it.name,
      stationsComplete,
      status: cv[COL_PL.status]?.text || 'Not Started',
      subtype: cv[COL_PL.subtype]?.text || 'Commercial',
      delivery: cv[COL_PL.delivery]?.display_value || null,
      masterPmId: cv[COL_PL.masterPmLink]?.linked_item_ids?.[0] || null,
      hours,
      formulaHours,
      finishingDays: parseInt(cv[COL_PL.finishingDays]?.text || '0'),
      pLam: pLamChecked,
      notes: cv[COL_PL.productionNotes]?.text || '',
      customWindow: override.customWindow || null,
      parallelPostFin: override.parallelPostFin || false,
      overrideNote: override.note || null,
    };
  });
}

async function loadCrewParents(gqlFn = gql) {
  // Paginate if needed (board has 292 items)
  const q = `query($cursor: String) {
    boards(ids: [${BOARD_CREW_ALLOC}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id
          column_values(ids: ["${COL_CA.weekDate}","${COL_CA.crewText}","${COL_CA.baseHours}","${COL_CA.timeOffHours}","${COL_CA.nonProdHours}"]) {
            id text
          }
        }
      }
    }
  }`;
  const results = [];
  let cursor = null;
  do {
    const data = await gqlFn(q, { cursor });
    const page = data.boards[0].items_page;
    for (const it of page.items) {
      const cv = {};
      for (const v of it.column_values) cv[v.id] = v.text;
      results.push({
        parentId: it.id,
        week: cv[COL_CA.weekDate],
        crew: cv[COL_CA.crewText],
        base: parseFloat(cv[COL_CA.baseHours] || '0'),
        timeOff: parseFloat(cv[COL_CA.timeOffHours] || '0'),
        nonProd: parseFloat(cv[COL_CA.nonProdHours] || '0'),
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return results;
}

async function loadTimeOff(gqlFn = gql) {
  const q = `query {
    boards(ids: [${BOARD_TIME_OFF}]) {
      items_page(limit: 100) {
        items {
          id name
          column_values(ids: ["${COL_TO.person}","${COL_TO.dates}","${COL_TO.hours}","${COL_TO.type}","${COL_TO.status}"]) {
            id text value
          }
        }
      }
    }
  }`;
  const data = await gqlFn(q);
  const items = data.boards[0].items_page.items;
  return items.map(it => {
    const cv = {};
    for (const v of it.column_values) cv[v.id] = v;
    let personId = null;
    try { personId = JSON.parse(cv[COL_TO.person].value).personsAndTeams[0].id; } catch (e) {}
    let from = null, to = null;
    try {
      const dv = JSON.parse(cv[COL_TO.dates].value);
      from = dv.from; to = dv.to;
    } catch (e) {}
    return {
      id: it.id,
      name: it.name,
      personId,
      from, to,
      type: cv[COL_TO.type]?.text,
      status: cv[COL_TO.status]?.text,
      hours: parseFloat(cv[COL_TO.hours]?.text || '0'),
    };
  }).filter(t => t.status === 'Approved');
}

async function loadSubitems(gqlFn = gql) {
  // Pull all subitems to see what's currently scheduled
  const q = `query($cursor: String) {
    boards(ids: [${BOARD_CREW_SUBITEMS}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id name
          parent_item {
            id
            column_values(ids: ["${COL_CA.weekDate}","${COL_CA.crewText}"]) { id text }
          }
          column_values(ids: ["${COL_SUB.station}","${COL_SUB.hours}","${COL_SUB.relatedJob}","${COL_SUB.assignedText}"]) {
            id text
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }
    }
  }`;
  const results = [];
  let cursor = null;
  do {
    const data = await gqlFn(q, { cursor });
    const page = data.boards[0].items_page;
    for (const it of page.items) {
      const cv = {};
      for (const v of it.column_values) cv[v.id] = v;
      const parentCv = {};
      for (const v of (it.parent_item?.column_values || [])) parentCv[v.id] = v.text;
      results.push({
        id: it.id,
        name: it.name,
        parentId: it.parent_item?.id,
        parentWeek: parentCv[COL_CA.weekDate],
        parentCrew: parentCv[COL_CA.crewText],
        station: cv[COL_SUB.station]?.text,
        hours: parseFloat(cv[COL_SUB.hours]?.text || '0'),
        masterPmId: cv[COL_SUB.relatedJob]?.linked_item_ids?.[0] || null,
        assignedText: cv[COL_SUB.assignedText]?.text,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return results;
}

// Read Active-group rows from the Manual Overrides board (B4). Returns one
// normalized row per Active item; Stale group is filtered out. Pure read —
// translation into forceAssignments / crewExclusions happens downstream in
// translateOverrideRows so this stays board-shape-only.
async function loadOverridesBoard({ gqlFn = gql } = {}) {
  const colIds = [
    COL_OV.job, COL_OV.station,
    COL_OV.fromCrew, COL_OV.fromWeek,
    COL_OV.toCrew, COL_OV.toWeek,
    COL_OV.hours, COL_OV.status, COL_OV.allowOverCap,
  ].map(s => `"${s}"`).join(',');

  const q = `query($cursor: String) {
    boards(ids: [${BOARD_OVERRIDES}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id
          group { id }
          column_values(ids: [${colIds}]) {
            id text value
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }
    }
  }`;

  const results = [];
  let cursor = null;
  do {
    const data = await gqlFn(q, { cursor });
    const page = data.boards[0].items_page;
    for (const item of page.items) {
      if (item.group?.id !== OVERRIDES_GROUP_ACTIVE) continue;
      const cv = {};
      for (const v of item.column_values) cv[v.id] = v;

      let allowOverCap = false;
      try {
        const parsed = JSON.parse(cv[COL_OV.allowOverCap]?.value || '{}');
        allowOverCap = parsed?.checked === 'true' || parsed?.checked === true;
      } catch (e) { /* unchecked column has no value */ }

      results.push({
        rowId: String(item.id),
        jobMpmId: cv[COL_OV.job]?.linked_item_ids?.[0] || null,
        station: cv[COL_OV.station]?.text || null,
        fromCrewParentId: cv[COL_OV.fromCrew]?.linked_item_ids?.[0] || null,
        fromWeek: cv[COL_OV.fromWeek]?.text || null,
        toCrewParentId: cv[COL_OV.toCrew]?.linked_item_ids?.[0] || null,
        toWeek: cv[COL_OV.toWeek]?.text || null,
        hours: parseFloat(cv[COL_OV.hours]?.text || '0'),
        status: cv[COL_OV.status]?.text || null,
        allowOverCap,
      });
    }
    cursor = page.cursor;
  } while (cursor);

  return results;
}

// Single entry point for all monday-side reads. Lets runPlan() and downstream
// tools (Phase 1 B5 validation pipeline, Phase 2 outputs) operate on a static
// snapshot instead of re-fetching every call. The token check lives here — if
// you can call loadAll() with a stub gqlFn, you don't need MONDAY_API_TOKEN.
async function loadAll({ gqlFn = gql } = {}) {
  if (gqlFn === gql && !TOKEN) {
    throw new Error('MONDAY_API_TOKEN env var required when using the default gql function');
  }
  const jobs = await loadJobs(gqlFn);
  const crewParents = await loadCrewParents(gqlFn);
  const timeOff = await loadTimeOff(gqlFn);
  const existingSubs = await loadSubitems(gqlFn);
  const overrideRows = await loadOverridesBoard({ gqlFn });
  return { jobs, crewParents, timeOff, existingSubs, overrideRows };
}

// ============================================================================
// CAPACITY MODEL
// ============================================================================

function buildCapacityGrid(crewParents, timeOffList, weeks, existingSubs, activeJobMasterPmIds) {
  // grid[crew][week] = { parentId, base, timeOff, available, committed, assignments }
  const grid = {};
  for (const crew of Object.keys(CREW_BASE_HOURS)) {
    grid[crew] = {};
    for (const wk of weeks) {
      grid[crew][wk] = {
        parentId: null,
        base: CREW_BASE_HOURS[crew],
        timeOff: 0,
        available: CREW_BASE_HOURS[crew],
        committed: 0,
        assignments: [],
      };
    }
  }

  // Populate parentId + base hours from Crew Allocation board
  for (const cp of crewParents) {
    if (grid[cp.crew]?.[cp.week]) {
      grid[cp.crew][cp.week].parentId = cp.parentId;
      grid[cp.crew][cp.week].base = cp.base;
      grid[cp.crew][cp.week].timeOff = cp.timeOff;
      grid[cp.crew][cp.week].available = Math.max(0, cp.base - cp.timeOff - cp.nonProd);
    }
  }

  // PATCH 2: Apply time off from Time Off board.
  // Compute total weekday hours per (person, week) across ALL approved TO entries,
  // then take MAX(rollup-derived timeOff, computed timeOff) so multi-day ranges
  // and multi-week ranges are respected without double-counting the rollup.
  const computedTimeOff = {};  // { personName: { week: hours } }
  for (const to of timeOffList) {
    const personName = Object.keys(CREW_PERSON_ID).find(k => CREW_PERSON_ID[k] === to.personId);
    if (!personName) continue;
    if (!to.from || !to.to) continue;
    let d = parseISO(to.from);
    const end = parseISO(to.to);
    while (d <= end) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const wkStart = toISO(getMondayOfWeek(d));
        if (!computedTimeOff[personName]) computedTimeOff[personName] = {};
        computedTimeOff[personName][wkStart] = (computedTimeOff[personName][wkStart] || 0) + 8;
      }
      d = addDays(d, 1);
    }
  }
  for (const [personName, weekMap] of Object.entries(computedTimeOff)) {
    for (const [wk, hrs] of Object.entries(weekMap)) {
      const entry = grid[personName]?.[wk];
      if (!entry) continue;
      // Only apply the delta beyond what the rollup already deducted
      if (hrs > entry.timeOff) {
        const delta = hrs - entry.timeOff;
        entry.available = Math.max(0, entry.available - delta);
        entry.timeOff = hrs;
      }
    }
  }

  // Bob pre-5/18 is subcontract-only, not salaried
  for (const wk of weeks) {
    if (wk < BOB_START_DATE) {
      grid.Bob[wk].available = 0;
      grid.Bob[wk].base = 0;
    }
  }

  // Departed crews carry zero capacity from their end date (their lingering
  // parent rows on the board are inert — no phantom 40h/wk in the grid).
  for (const [crew, endDate] of Object.entries(CREW_END_DATES)) {
    if (!grid[crew]) continue;
    for (const wk of weeks) {
      if (wk >= endDate && grid[crew][wk]) {
        grid[crew][wk].available = 0;
        grid[crew][wk].base = 0;
        grid[crew][wk].departed = true;
      }
    }
  }

  // PATCH A: Pre-load ONLY subitems from jobs NOT being rescheduled
  // (subitems for active jobs will be deleted, so don't count their load)
  for (const sub of existingSubs) {
    if (activeJobMasterPmIds.has(sub.masterPmId)) continue;  // skip — will be deleted
    if (!sub.parentCrew || !sub.parentWeek) continue;
    const slot = grid[sub.parentCrew]?.[sub.parentWeek];
    if (!slot) continue;
    slot.committed += sub.hours;
    slot.assignments.push({
      job: sub.name.split(' — ')[0],
      station: sub.station,
      hours: sub.hours,
      preExisting: true,
    });
  }

  // PATCH D: Apply crewCapacityOverrides
  for (const [week, crewMap] of Object.entries(OVERRIDES.crewCapacityOverrides || {})) {
    for (const [crew, override] of Object.entries(crewMap)) {
      const slot = grid[crew]?.[week];
      if (!slot) continue;
      if (override.available !== undefined) {
        slot.available = override.available;
        slot.overrideReason = override.reason;
      }
      if (override.weekendHours !== undefined) {
        slot.available += override.weekendHours;
        slot.weekendBoost = override.weekendHours;
        slot.weekendReason = override.reason;
      }
    }
  }

  // PATCH 1: Subcontractor pool — add each sub as a virtual crew member
  // with capacity for the ONE week they're listed on (not recurring)
  for (const [week, subs] of Object.entries(OVERRIDES.subcontractors || {})) {
    for (const sub of subs) {
      if (!grid[sub.name]) grid[sub.name] = {};
      grid[sub.name][week] = {
        parentId: null,
        base: sub.hours,
        timeOff: 0,
        available: sub.hours,
        committed: 0,
        assignments: [],
        subcontractor: true,
        allowedStations: sub.allowedStations || [],
        assignedJobId: sub.assignedJobId || null,
        fallbackOnly: sub.fallbackOnly || false,
        subcontractorReason: sub.reason || null,
      };
    }
  }

  return grid;
}

// ============================================================================
// SCHEDULING ALGORITHM
// ============================================================================

function getPrimary(subtype, station) {
  return ROUTING[subtype]?.[station] || [];
}

function getSecondary(subtype, station) {
  return SECONDARY[subtype]?.[station] || [];
}

function getCandidates(subtype, station) {
  const p = getPrimary(subtype, station);
  const s = getSecondary(subtype, station);
  return [...p, ...s];
}

// PATCH 3: Hard rules — placement constraints that override SECONDARY routing.
// Returns null if OK, or a string describing the violation.
function hardRuleViolation(crew, station, subtype, week) {
  // Departures: blocks planner placement AND board-override forces (the
  // validator's checkHardRule consumes this). Week-gated so historical
  // re-validation of pre-departure rows stays valid.
  if (crew === 'Ian' && week >= '2026-06-11') {
    return 'Ian left the team effective 2026-06-11';
  }
  if (crew === 'Ken' && station === 'Benchwork') {
    return 'Ken never does Benchwork';
  }
  if (crew === 'Ken' && station === 'Post Fin Cab Assembly' && subtype !== 'Commercial') {
    return `Ken Post Fin is Commercial-only (subtype: ${subtype})`;
  }
  if (crew === 'Ken' && station === 'Pre Fin Cab Assembly' && subtype !== 'Commercial') {
    return `Ken Pre Fin is Commercial-only (subtype: ${subtype})`;
  }
  if (crew === 'Spencer' && (station === 'Panel Processing' || station === 'Engineering')) {
    return `Spencer never does ${station}`;
  }
  if (crew === 'Rob' && station !== 'Engineering') {
    return 'Rob can only do Engineering';
  }
  if (crew === 'Bob' && week < BOB_START_DATE) {
    return `Bob employment starts ${BOB_START_DATE} — pre-date routing requires subcontractor entry`;
  }
  return null;
}

// PATCH 3 + B5c: Per-job crew exclusions from two sources, different granularity.
//
//   - Coarse JSON (OVERRIDES.crewExclusions): { [crew]: { excludeJobs: [...], reason } }
//     Blocks `crew` from `jobId` across ALL (station, week).
//   - Fine-grained board (activeCrewExclusions.board): [{ crew, jobId, station, week, reason, _sourceRowId }]
//     Blocks `crew` from `jobId` ONLY at the matching (station, week) tuple —
//     emitted by translateOverrideRows from a pure-clear Manual Overrides row.
//
// Precedence: when both apply to the same (crew, jobId), the fine-grained
// board entry's reason is returned in preference to the coarse JSON reason.
// Per E8 (Phase 1 plan §D.2), the board is the more-recent source-of-truth;
// surfacing the board reason in rejection messaging lets an operator trace
// the rejection back to the override row that produced it. The coarse JSON
// path remains the fallback so structural-config exclusions (e.g., "Spencer
// never Frameless Engineering") continue to fire when no run is in progress
// (activeCrewExclusions === null) — protects test/import-side usage.
function jobExclusionViolation(crew, jobId, station, week) {
  if (activeCrewExclusions?.board) {
    for (const b of activeCrewExclusions.board) {
      if (b.crew !== crew) continue;
      if (String(b.jobId) !== String(jobId)) continue;
      if (b.station && b.station !== station) continue;
      if (b.week && b.week !== week) continue;
      return b.reason || `${crew} excluded from ${jobId} (board fine-grained: ${b.station || '*'}/${b.week || '*'})`;
    }
  }
  const jsonSource = activeCrewExclusions?.json || OVERRIDES.crewExclusions || {};
  const ex = jsonSource[crew];
  if (!ex) return null;
  if (ex.excludeJobs?.includes(jobId)) {
    return ex.reason || `${crew} excluded from job ${jobId}`;
  }
  return null;
}

// PATCH 4: forceAssignments — pinned (crew, jobId, stations[], week, hours?) placements
function getForceAssignments(jobId, station, week) {
  const source = activeForceAssignments !== null ? activeForceAssignments : (OVERRIDES.forceAssignments || []);
  const matches = [];
  for (const entry of source) {
    if (entry.jobId !== jobId) continue;
    if (!entry.stations?.includes(station)) continue;
    if (entry.week !== week) continue;
    matches.push(entry);
  }
  return matches;
}

// B4: per-run merged forceAssignments. runPlan() sets this to the union of
// OVERRIDES.forceAssignments (JSON) + board-derived forces (translated from
// the Manual Overrides board), board winning on tuple match. getForceAssignments
// reads from here when non-null so the planner sees the merged view without
// any callsite needing to thread the merged set through. Null = use OVERRIDES
// directly (matches pre-B4 behavior; used by tests + tooling that import this
// module without calling runPlan).
let activeForceAssignments = null;

// B5c: per-run merged crewExclusions, mirroring activeForceAssignments. Shape
// matches mergeCrewExclusions's output: { json, board } — coarse JSON map plus
// fine-grained board entries. jobExclusionViolation consults this when non-null,
// applying fine-grained-board-wins-over-coarse-JSON precedence (see that
// function's docstring). Null = pre-B5c fallback (OVERRIDES.crewExclusions
// only). Set/cleared by runPlan inside the same try/finally that protects
// activeForceAssignments — both must reset on every exit path so the next run
// (and any test that calls runPlan back-to-back) starts clean.
let activeCrewExclusions = null;

// B4: translate normalized Manual Overrides board rows into the planner's
// internal primitives. Pure — no monday I/O.
//
// Override-board vocabulary: (job × station × from_crew × from_week × to_crew ×
// to_week × hours). Phase 1 maps each row to ONE planner primitive based on
// From/To presence:
//
//   - Pure assign (empty From, has To): emit a forceAssignment for the to-side.
//   - Pure clear (has From, empty To): emit a fine-grained crewExclusion for
//     (job × station × week × from_crew).
//   - Move (both sides):  emit ONLY the to-side forceAssignment. The from-side
//     is metadata for human readability; the operator owns the from-side's
//     natural auto-routing. Phase 1 does NOT model bidirectional override
//     propagation (i.e., we don't auto-subtract from-side hours from the plan;
//     the to-side commitment is the load-bearing claim).
//
// Phase 1.1: Pending + Applied rows both translate. Conflict / Cleared rows
// skip silently — Conflict rows require an operator's Conflict→Pending flip
// in monday UI to retry; Cleared rows are terminal. Pre-1.1 this filter
// was Pending-only, which dropped Applied rows on subsequent --plan runs and
// silently un-applied their effect at the next --execute. Spec Section B
// Step 3 calls for translating Applied rows; this filter now meets that.
//
// Translating an Applied row on Day N produces the same forceAssignment /
// crewExclusion it did on Day 1 (the row's data hasn't changed, only its
// Status). Idempotent.
//
// Unresolved refs (Master PM id with no PL row, or Crew Allocation parent id
// with no matching crewParent) defer to an `untranslatable` bucket so B5's
// validation pipeline can flag them as Conflict — translating bogus rows would
// crash here, which loses the operator's audit trail.
function translateOverrideRows(rows, plJobs, crewParents) {
  const forceAssignments = [];
  const crewExclusions = [];
  const untranslatable = [];

  const jobByMpm = new Map();
  for (const j of plJobs || []) {
    if (j.masterPmId != null) jobByMpm.set(String(j.masterPmId), j);
  }
  const crewByParent = new Map();
  for (const p of crewParents || []) {
    crewByParent.set(String(p.parentId), { crew: p.crew, week: p.week });
  }

  for (const row of rows || []) {
    if (row.status !== 'Pending' && row.status !== 'Applied') continue;

    const job = jobByMpm.get(String(row.jobMpmId));
    if (!job) {
      untranslatable.push({
        rowId: row.rowId,
        reason: `unresolved job: Master PM id ${row.jobMpmId} has no Production Load row`,
      });
      continue;
    }

    const fromRef = row.fromCrewParentId
      ? crewByParent.get(String(row.fromCrewParentId)) || false
      : null;
    const toRef = row.toCrewParentId
      ? crewByParent.get(String(row.toCrewParentId)) || false
      : null;

    if (fromRef === false) {
      untranslatable.push({
        rowId: row.rowId,
        reason: `unresolved From crew parent id ${row.fromCrewParentId} — no matching Crew Allocation parent row`,
      });
      continue;
    }
    if (toRef === false) {
      untranslatable.push({
        rowId: row.rowId,
        reason: `unresolved To crew parent id ${row.toCrewParentId} — no matching Crew Allocation parent row`,
      });
      continue;
    }

    if (!fromRef && toRef) {
      forceAssignments.push({
        crew: toRef.crew,
        jobId: job.id,
        stations: [row.station],
        week: toRef.week,
        hours: row.hours,
        reason: `Manual Overrides board row ${row.rowId} (pure assign)`,
        _sourceRowId: row.rowId,
      });
    } else if (fromRef && !toRef) {
      crewExclusions.push({
        crew: fromRef.crew,
        jobId: job.id,
        station: row.station,
        week: fromRef.week,
        reason: `Manual Overrides board row ${row.rowId} (pure clear)`,
        _sourceRowId: row.rowId,
      });
    } else if (fromRef && toRef) {
      forceAssignments.push({
        crew: toRef.crew,
        jobId: job.id,
        stations: [row.station],
        week: toRef.week,
        hours: row.hours,
        reason: `Manual Overrides board row ${row.rowId} (move from ${fromRef.crew} ${fromRef.week})`,
        _sourceRowId: row.rowId,
      });
    } else {
      untranslatable.push({
        rowId: row.rowId,
        reason: 'both From and To crew refs are empty; row has no actionable shape',
      });
    }
  }

  return { forceAssignments, crewExclusions, untranslatable };
}

// B4: merge JSON-source forceAssignments with board-derived forces. Board wins
// on (jobId × station × week × crew) tuple match. Pure.
//
// JSON entries may carry multi-station arrays (e.g., one entry covering both
// Pack & Ship and Delivery in the same week); flatten them before tuple
// comparison so a board override targeting one station doesn't drop the
// JSON entry's other stations.
function mergeForceAssignments(jsonForces, boardForces) {
  const tupleKey = e => `${e.jobId}|${e.stations?.[0]}|${e.week}|${e.crew}`;

  const jsonFlat = [];
  for (const e of jsonForces || []) {
    for (const station of e.stations || []) {
      jsonFlat.push({ ...e, stations: [station] });
    }
  }

  const boardByKey = new Map();
  for (const b of boardForces || []) boardByKey.set(tupleKey(b), b);

  const merged = [];
  const conflicts = [];

  for (const j of jsonFlat) {
    const k = tupleKey(j);
    if (boardByKey.has(k)) {
      conflicts.push({ key: k, jsonSource: j, boardSource: boardByKey.get(k) });
      continue;
    }
    merged.push(j);
  }
  for (const b of boardForces || []) merged.push(b);

  return { merged, conflicts };
}

// B4: merge JSON crewExclusions with board-derived fine-grained exclusions.
// The two are different shapes by design:
//   - JSON  is coarse: { [crew]: { excludeJobs: [...], reason } } — excludes
//     a crew from all (station, week) for a given jobId.
//   - Board is fine:   [{ crew, jobId, station, week, reason, _sourceRowId }] —
//     excludes a crew from one specific (station, week) for a jobId.
//
// They coexist; the merge result preserves both. Conflict-logging is for the
// redundant case where a board fine-grained entry re-asserts a (crew, jobId)
// the JSON has already excluded coarsely — the board entry stays in the
// merged set, but the conflict log surfaces the duplication so an operator
// can clear the redundant board row.
//
// The planner does not yet consume board.* exclusions in B4 (different
// granularity needs validator-side wiring — that's B5+ work). Computing the
// merge + conflict log now is what B4 owes; consumption follows.
function mergeCrewExclusions(jsonExclusions, boardExclusions) {
  const conflicts = [];
  for (const b of boardExclusions || []) {
    const jsonEntry = jsonExclusions?.[b.crew];
    if (jsonEntry?.excludeJobs?.includes(b.jobId)) {
      conflicts.push({
        crew: b.crew,
        jobId: b.jobId,
        station: b.station,
        week: b.week,
        jsonReason: jsonEntry.reason,
        boardReason: b.reason,
      });
    }
  }
  return {
    merged: {
      json: jsonExclusions || {},
      board: boardExclusions || [],
    },
    conflicts,
  };
}

// Apply all matching forces for (job, station, week). Mutates grid.
// Returns { placements, hoursConsumed, warnings }.
// Throws if a force violates a hard rule (don't silently override hard rules).
function applyForceAssignments(grid, job, station, week, weekHours) {
  const placements = [];
  const warnings = [];
  let consumed = 0;
  const matches = getForceAssignments(job.id, station, week);
  for (const force of matches) {
    const hrs = force.hours !== undefined
      ? force.hours
      : Math.max(0, weekHours - consumed);
    if (hrs <= 0) continue;
    const ruleHit = hardRuleViolation(force.crew, station, job.subtype, week);
    if (ruleHit) {
      throw new Error(`forceAssignment violates hard rule: ${force.crew} on ${station} ${week} for ${job.name} — ${ruleHit}`);
    }
    const slot = grid[force.crew]?.[week];
    if (!slot) {
      warnings.push(`forceAssignment skipped (${job.name} / ${station} ${week}): ${force.crew} has no grid entry`);
      continue;
    }
    if (!slot.parentId && !slot.subcontractor) {
      warnings.push(`forceAssignment skipped (${job.name} / ${station} ${week}): ${force.crew} has no allocation parent row`);
      continue;
    }
    const wouldBe = slot.committed + hrs;
    if (wouldBe > slot.available * SOFT_CAP_MULTIPLIER) {
      warnings.push(`forceAssignment exceeds cap: ${force.crew} ${week} would be ${wouldBe.toFixed(1)}/${slot.available} (over by ${(wouldBe - slot.available).toFixed(1)} hrs) — placing anyway per user override`);
    }
    slot.committed = wouldBe;
    slot.assignments.push({ job: job.name, station, hours: hrs, forced: true });
    placements.push({
      crew: force.crew,
      week,
      hours: Number(hrs.toFixed(2)),
      parentId: slot.parentId,
      station,
      jobId: job.id,
      jobName: job.name,
      masterPmId: job.masterPmId,
      forced: true,
      forceReason: force.reason || null,
    });
    consumed += hrs;
  }
  return { placements, hoursConsumed: consumed, warnings };
}

function weeksCountForHours(hours) {
  if (hours <= 40) return 1;
  if (hours <= 80) return 2;
  if (hours <= 120) return 3;
  return Math.ceil(hours / 40);
}

/**
 * Given a delivery date and job hours, compute ideal station windows.
 * Returns object with windowStart/windowEnd for each station.
 */
function computeWindows(job) {
  const d = job.delivery;
  if (!d) return null;

  const deliveryWeek = toISO(getMondayOfWeek(parseISO(d)));
  const windows = {
    packShip: { start: deliveryWeek, end: toISO(addDays(parseISO(deliveryWeek), 4)) },
  };

  // PATCH C: For each station, apply customWindow override if provided; else compute
  // Work backwards, but SKIP stations with 0 hours entirely (no window assigned)

  // Post Fin (final assembly station before pack/ship)
  let postfinEndWeek = deliveryWeek;
  if (job.hours.postfin > 0) {
    if (job.customWindow?.postfin) {
      windows.postfin = job.customWindow.postfin;
      postfinEndWeek = windows.postfin.start;
    } else {
      const postfinWeeks = weeksCountForHours(job.hours.postfin);
      const postfinStart = toISO(addDays(parseISO(postfinEndWeek), -7 * (postfinWeeks - 1)));
      windows.postfin = { start: postfinStart, end: toISO(addDays(parseISO(postfinEndWeek), 4)) };
    }
  }

  // A2: Finish cycle (only if Finishing Days > 0 and not P-Lam).
  // Anchor: Finish Return must land on or before the Monday Post-Fin starts —
  // operationally the finisher returns cabs the Friday before Post-Fin week.
  // Drop = N business days back from Return anchor.
  let finishDrop = null, finishReturn = null;
  if (job.finishingDays > 0 && !job.pLam) {
    const postfinAnchor = job.hours.postfin > 0 ? (windows.postfin?.start || deliveryWeek) : deliveryWeek;
    const provisionalReturn = toISO(addDays(parseISO(postfinAnchor), -3));
    finishDrop = businessDaysBack(provisionalReturn, job.finishingDays);
    finishReturn = addBusinessDays(finishDrop, job.finishingDays);
    windows.finishDrop = finishDrop;
    windows.finishReturn = finishReturn;
  }

  // Pre Fin (skip if 0 hrs)
  let prefinStartWeek = null;
  if (job.hours.prefin > 0) {
    if (job.customWindow?.prefin) {
      windows.prefin = job.customWindow.prefin;
      prefinStartWeek = windows.prefin.start;
    } else {
      // A2: Pre-Fin end must land in the week BEFORE finishDrop's week so the
      // last Friday of pre-fin work is at least 1 business day before pickup.
      // -7 calendar days lands somewhere in the prior week regardless of the
      // weekday finishDrop falls on; getMondayOfWeek then snaps to that Monday.
      const prefinEndTarget = finishDrop
        ? toISO(addDays(parseISO(finishDrop), -7))
        : (job.hours.postfin > 0
            ? toISO(addDays(parseISO(windows.postfin.start), -3))
            : toISO(addDays(parseISO(deliveryWeek), -3)));
      const prefinEndWeek = toISO(getMondayOfWeek(parseISO(prefinEndTarget)));
      const prefinWeeks = weeksCountForHours(job.hours.prefin);
      prefinStartWeek = toISO(addDays(parseISO(prefinEndWeek), -7 * (prefinWeeks - 1)));
      windows.prefin = { start: prefinStartWeek, end: toISO(addDays(parseISO(prefinEndWeek), 4)) };
    }
  }

  // Benchwork (skip if 0 hrs); concurrent with Pre Fin if both exist
  let benchStartWeek = null;
  if (job.hours.bench > 0) {
    if (job.customWindow?.bench) {
      windows.bench = job.customWindow.bench;
      benchStartWeek = windows.bench.start;
    } else {
      const benchEndRef = prefinStartWeek
        ? toISO(addDays(parseISO(windows.prefin.end), 0))
        : (finishDrop
            ? toISO(addDays(parseISO(finishDrop), -7))
            : (job.hours.postfin > 0
                ? toISO(addDays(parseISO(windows.postfin.start), -3))
                : toISO(addDays(parseISO(deliveryWeek), -3))));
      const benchEndWeek = toISO(getMondayOfWeek(parseISO(benchEndRef)));
      const benchWeeks = weeksCountForHours(job.hours.bench);
      benchStartWeek = toISO(addDays(parseISO(benchEndWeek), -7 * (benchWeeks - 1)));
      windows.bench = { start: benchStartWeek, end: toISO(addDays(parseISO(benchEndWeek), 4)) };
    }
  }

  // Panel Processing (skip if 0 hrs)
  let panelStartWeek = null;
  if (job.hours.panel > 0) {
    if (job.customWindow?.panel) {
      windows.panel = job.customWindow.panel;
      panelStartWeek = windows.panel.start;
    } else {
      // Ends one week before the earliest of bench/prefin/postfin; or lands IN delivery week for countertop-only
      const refStartArr = [benchStartWeek, prefinStartWeek, windows.postfin?.start].filter(Boolean);
      const panelEndWeek = refStartArr.length > 0
        ? toISO(addDays(parseISO(refStartArr.sort()[0]), -7))  // one week before earliest downstream station
        : deliveryWeek;  // no downstream stations → Panel lands same week as delivery (Cator Ruma case)
      const panelWeeks = weeksCountForHours(job.hours.panel);
      panelStartWeek = toISO(addDays(parseISO(panelEndWeek), -7 * (panelWeeks - 1)));
      windows.panel = { start: panelStartWeek, end: toISO(addDays(parseISO(panelEndWeek), 4)) };
    }
  }

  // Engineering (skip if 0 hrs); ends one week before Panel, or before earliest downstream station
  if (job.hours.eng > 0) {
    if (job.customWindow?.eng) {
      windows.eng = job.customWindow.eng;
    } else {
      const refStartArr = [panelStartWeek, benchStartWeek, prefinStartWeek, windows.postfin?.start].filter(Boolean);
      const engEndWeek = refStartArr.length > 0
        ? toISO(addDays(parseISO(refStartArr.sort()[0]), -7))
        : deliveryWeek;
      const engWeeks = weeksCountForHours(job.hours.eng);
      const engStartWeek = toISO(addDays(parseISO(engEndWeek), -7 * (engWeeks - 1)));
      windows.eng = { start: engStartWeek, end: toISO(addDays(parseISO(engEndWeek), 4)) };
    }
  }

  assertFinishingCycleValid(job, windows);
  return windows;
}

// A2/A3: pure non-throwing check. Returns { valid, errors[] }. Used by both
// assertFinishingCycleValid (compute-time defense) and the A3 reporting path.
// Skips pLam / zero-finishing / missing-window cases as valid (no constraint).
function checkFinishingCycleValid(job, windows) {
  const errors = [];
  if (!job || job.pLam || !job.finishingDays || job.finishingDays <= 0) {
    return { valid: true, errors };
  }
  if (!windows || !windows.finishDrop || !windows.finishReturn) {
    return { valid: true, errors };
  }
  if (windows.prefin) {
    const prefinEndPlus1 = addBusinessDays(windows.prefin.end, 1);
    if (prefinEndPlus1 > windows.finishDrop) {
      errors.push(
        `Pre-Fin ends ${windows.prefin.end} (next BD ${prefinEndPlus1}) but Finish Drop is ${windows.finishDrop} — ` +
        `pre-fin would still be in progress when finisher arrives. ` +
        `Push delivery date or relax customWindow.prefin.`
      );
    }
  }
  if (windows.postfin) {
    if (windows.finishReturn > windows.postfin.start) {
      errors.push(
        `Finish Return ${windows.finishReturn} > Post-Fin start ${windows.postfin.start} — ` +
        `finisher hasn't returned cabs before assembly is supposed to begin. ` +
        `Push delivery date or relax customWindow.postfin.`
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

// A2: throws if the finishing cycle leaves zero days for the finisher.
// Applies to non-pLam jobs with finishingDays > 0 — both auto-computed windows
// and user-supplied customWindow placements (a violating customWindow means the
// override itself is operationally invalid and needs the user to fix it).
function assertFinishingCycleValid(job, windows) {
  const { valid, errors } = checkFinishingCycleValid(job, windows);
  if (!valid) {
    throw new Error(`[finishing-cycle] ${job.name}: ${errors.join('; ')}`);
  }
}

// A3: count business days from start to end inclusive (Mon-Fri).
// Returns 0 if start > end. Holidays not modeled (matches addBusinessDays).
function businessDaysBetween(startISO, endISO) {
  if (startISO > endISO) return 0;
  let d = parseISO(startISO);
  const end = parseISO(endISO);
  let count = 0;
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    d = addDays(d, 1);
  }
  return count;
}

// A3: build one row of the finishing-cycle validation table for a single job.
// Pure — no I/O. Returns either a 'skipped' marker (pLam, no finishing, missing
// windows — these don't get per-job rows in the report) or a 'row' with the
// data the report displays + the valid/errors verdict from checkFinishingCycleValid.
function buildFinishingCycleRow(job, windows) {
  if (!job) return { kind: 'skipped', reason: 'no job' };
  if (job.pLam) return { kind: 'skipped', jobId: job.id, jobName: job.name, reason: 'pLam' };
  if (!job.finishingDays || job.finishingDays <= 0) {
    return { kind: 'skipped', jobId: job.id, jobName: job.name, reason: 'no finishing' };
  }
  if (!windows || !windows.prefin || !windows.postfin || !windows.finishDrop || !windows.finishReturn) {
    return { kind: 'skipped', jobId: job.id, jobName: job.name, reason: 'missing windows' };
  }
  const prefinEnd = windows.prefin.end;
  const postfinStart = windows.postfin.start;
  const earliestFinisherStart = addBusinessDays(prefinEnd, 1);
  const latestFinisherEnd = addBusinessDays(postfinStart, -1);
  const gap = businessDaysBetween(earliestFinisherStart, latestFinisherEnd);
  const { valid, errors } = checkFinishingCycleValid(job, windows);
  return {
    kind: 'row',
    jobId: job.id,
    jobName: job.name,
    finishingDays: job.finishingDays,
    prefinEnd,
    postfinStart,
    finishDrop: windows.finishDrop,
    finishReturn: windows.finishReturn,
    gap,
    valid,
    errors,
  };
}

// A3: pure gate logic for --execute. Inspects plan.finishingCycleReport and
// returns { block, invalidRows[], bypassed? }. block=true → execute() refuses
// to run. force=true → block=false even with invalid rows, bypassed=true so
// the caller can log a "bypassed per --force" note.
function checkExecuteGate(plan, opts = {}) {
  const fcr = plan?.finishingCycleReport;
  const invalidRows = (fcr?.rows || []).filter(r => r && r.valid === false);
  if (invalidRows.length === 0) {
    return { block: false, invalidRows: [] };
  }
  if (opts.force) {
    return { block: false, invalidRows, bypassed: true };
  }
  return { block: true, invalidRows };
}

// A5: per-job writeback entry for the Production Load Board finish-date columns.
// Pure — derives the entry the executor will apply. For pLam jobs and jobs with
// finishingDays=0, both dates are null (executor clears the PL columns). For
// non-pLam jobs whose windows lack finish dates (defensive — shouldn't happen
// post-A2), nulls are emitted so the column gets cleared rather than left stale.
function buildFinishDateWriteback(job, windows) {
  const finishDrop = windows && windows.finishDrop ? windows.finishDrop : null;
  const finishReturn = windows && windows.finishReturn ? windows.finishReturn : null;
  return {
    jobId: job.id,
    jobName: job.name,
    plItemId: job.id,
    finishDrop,
    finishReturn,
  };
}

// A5: convert plan.finishDateWritebacks[] into mutation params for
// change_multiple_column_values. Each entry produces one { plItemId,
// columnValues } pair. Dates → { date: 'YYYY-MM-DD' }; null → null (clears the
// monday column). Caller issues one mutation per entry against BOARD_PL.
function buildFinishDateMutations(plan, opts = {}) {
  const finishDropCol = opts.finishDropCol ?? COL_PL.finishDrop;
  const finishReturnCol = opts.finishReturnCol ?? COL_PL.finishReturn;
  const writebacks = plan?.finishDateWritebacks;
  if (!Array.isArray(writebacks) || writebacks.length === 0) return [];
  return writebacks.map(w => ({
    plItemId: w.plItemId,
    columnValues: {
      [finishDropCol]: w.finishDrop ? { date: w.finishDrop } : null,
      [finishReturnCol]: w.finishReturn ? { date: w.finishReturn } : null,
    },
  }));
}

/**
 * Allocate hours to a specific week+crew. Spreads over multiple candidates if
 * the Primary is at capacity.
 */
function allocateStationWeek(grid, job, station, week, hours, candidates) {
  const placements = [];
  const rejections = [];  // { crew, reason } — for warning context
  let remaining = hours;

  for (const crew of candidates) {
    if (remaining <= 0) break;
    if (!grid[crew]?.[week]) continue;
    const slot = grid[crew][week];
    // PATCH 3: Apply hard rules + crew exclusions to non-subcontractor crew
    if (!slot.subcontractor) {
      const ruleHit = hardRuleViolation(crew, station, job.subtype, week);
      if (ruleHit) { rejections.push({ crew, reason: `hard rule: ${ruleHit}` }); continue; }
      const exclHit = jobExclusionViolation(crew, job.id, station, week);
      if (exclHit) { rejections.push({ crew, reason: `excluded: ${exclHit}` }); continue; }
    }
    // Subcontractor slots: no monday parent, but must match station + (optionally) job
    if (slot.subcontractor) {
      if (!slot.allowedStations?.includes(station)) continue;
      if (slot.assignedJobId && slot.assignedJobId !== job.id) continue;
    } else if (!slot.parentId) {
      continue;  // regular crew with no allocation parent row → skip
    }
    const softCap = slot.available * SOFT_CAP_MULTIPLIER;
    const room = Math.max(0, softCap - slot.committed);
    if (room <= 0) continue;
    const toPlace = Math.min(remaining, room);
    const placement = {
      crew,
      week,
      hours: Number(toPlace.toFixed(2)),
      parentId: slot.parentId,
      station,
      jobId: job.id,
      jobName: job.name,
      masterPmId: job.masterPmId,
    };
    if (slot.subcontractor) {
      placement.isSubcontractor = true;
      placement.subcontractorReason = slot.subcontractorReason;
    }
    placements.push(placement);
    slot.committed += toPlace;
    slot.assignments.push({ job: job.name, station, hours: toPlace });
    remaining -= toPlace;
  }

  return { placements, unplaced: Number(remaining.toFixed(2)), rejections };
}

/**
 * Schedule a single station for a job across its window.
 * Distributes hours across the station's weeks, trying Primary first,
 * then falling back to Secondary if Primary full.
 */
function scheduleStation(grid, job, station, hours, windowStart, windowEnd) {
  if (hours <= 0) return { placements: [], unplaced: 0 };

  const weeks = [];
  let d = parseISO(windowStart);
  while (toISO(d) <= windowEnd) {
    weeks.push(toISO(d));
    d = addDays(d, 7);
  }

  const candidates = getCandidates(job.subtype, station);
  const primary = getPrimary(job.subtype, station);

  const allPlacements = [];
  const allRejections = new Map();  // crew → reason (last reason wins; aggregated for warning)
  const allWarnings = [];  // PATCH 4: forceAssignment warnings (cap exceeded, missing parent, etc.)

  // PATCH 5 (2026-04-25): cumulative-budget force tracking.
  // Was: const perWeek = hours / weeks.length, force capped at perWeek per week.
  // Bug: a force exceeding perWeek in an early week didn't shrink later weeks' budgets,
  // causing over-placement (e.g., Edge Optics Bench 49.9h budget → 58.21h placed across
  // 3 weeks because each week kept a fresh 16.63h auto-placement budget regardless of
  // a prior 24.95h force). Fix: recompute perWeek from remainingBudget/weeksRemaining
  // each iteration; deduct both forced and auto-placed hours from the running total.
  let remainingBudget = hours;

  for (let i = 0; i < weeks.length; i++) {
    const wk = weeks[i];
    const weeksRemaining = weeks.length - i;
    const perWeek = weeksRemaining > 0 ? remainingBudget / weeksRemaining : 0;

    // PATCH 4: Apply force assignments first; deduct from this week's share before normal routing
    const forceResult = applyForceAssignments(grid, job, station, wk, perWeek);
    allPlacements.push(...forceResult.placements);
    for (const w of forceResult.warnings) allWarnings.push(w);

    // PATCH 5: clamp force consumption to remaining budget; warn if forces exceed it.
    let forceConsumed = forceResult.hoursConsumed;
    if (forceConsumed > remainingBudget + 1e-9) {
      allWarnings.push(`forceAssignment exceeds remaining job budget for ${job.name} / ${station} ${wk}: forces totaled ${forceConsumed.toFixed(2)}h but only ${remainingBudget.toFixed(2)}h remained in window — clamping budget tracking (placements stand)`);
      forceConsumed = remainingBudget;
    }
    remainingBudget = Math.max(0, remainingBudget - forceConsumed);

    const remainingThisWeek = Math.max(0, perWeek - forceResult.hoursConsumed);
    if (remainingThisWeek <= 0 || remainingBudget <= 0) continue;

    // PATCH 1 + fallbackOnly: Find subcontractor pools active this week, eligible for this station+job.
    // - assignedSubs: assignedJobId === job.id, NOT fallbackOnly → BEFORE primary
    // - generalSubs:  no assignedJobId, NOT fallbackOnly → AFTER secondary, BEFORE fallback
    // - fallbackSubs: fallbackOnly === true (any assignedJobId) → LAST (overflow only)
    // - Subs with assignedJobId !== job.id are excluded entirely
    const assignedSubs = [];
    const generalSubs = [];
    const fallbackSubs = [];
    for (const [name, slots] of Object.entries(grid)) {
      const slot = slots[wk];
      if (!slot || !slot.subcontractor) continue;
      if (!slot.allowedStations?.includes(station)) continue;
      if (slot.assignedJobId && slot.assignedJobId !== job.id) continue;
      if (slot.fallbackOnly) {
        fallbackSubs.push(name);
      } else if (slot.assignedJobId) {
        assignedSubs.push(name);
      } else {
        generalSubs.push(name);
      }
    }
    const candidatesForWk = [...assignedSubs, ...candidates, ...generalSubs, ...fallbackSubs];

    // PATCH 3: Filter primaries through hard rules + exclusions.
    // PATCH 6 (2026-05-18): Also exclude primaries with no remaining room
    // (committed >= softCap). Bug 4 (BCH PostFin dupe): when a primary p1
    // is at softCap, the multi-primary split below sent iter-A's perPrimary
    // share through p1's candidate list, fell through to p2, then ran iter-B
    // for p2 which placed ANOTHER perPrimary share on p2 — producing two
    // separate placements on the same crew. Filtering full primaries here
    // collapses primariesAvailableThisWeek.length to 1 in that case, which
    // routes to the else-branch (single allocateStationWeek with full hours)
    // and emits a single placement.
    const primariesAvailableThisWeek = primary.filter(c => {
      if (!grid[c]?.[wk]?.parentId || grid[c][wk].available <= 0) return false;
      if (hardRuleViolation(c, station, job.subtype, wk)) return false;
      if (jobExclusionViolation(c, job.id, station, wk)) return false;
      const softCap = grid[c][wk].available * SOFT_CAP_MULTIPLIER;
      if (grid[c][wk].committed >= softCap) return false;
      return true;
    });

    let autoPlacedThisWeek = 0;

    if (primariesAvailableThisWeek.length > 1) {
      // Split evenly among primaries; sub buckets flank each split in priority order
      const perPrimary = remainingThisWeek / primariesAvailableThisWeek.length;
      for (const p of primariesAvailableThisWeek) {
        const others = [...candidates.filter(c => c !== p), ...generalSubs, ...fallbackSubs];
        const result = allocateStationWeek(grid, job, station, wk, perPrimary, [...assignedSubs, p, ...others]);
        allPlacements.push(...result.placements);
        autoPlacedThisWeek += (perPrimary - result.unplaced);
        for (const r of result.rejections || []) allRejections.set(r.crew, r.reason);
      }
    } else {
      const result = allocateStationWeek(grid, job, station, wk, remainingThisWeek, candidatesForWk);
      allPlacements.push(...result.placements);
      autoPlacedThisWeek += (remainingThisWeek - result.unplaced);
      for (const r of result.rejections || []) allRejections.set(r.crew, r.reason);
    }

    // PATCH 5: deduct auto-placed hours so next iteration's perWeek reflects what's actually left.
    remainingBudget = Math.max(0, remainingBudget - autoPlacedThisWeek);
  }

  // PATCH 7 (2026-06-11): unplaced = end-of-loop remainingBudget, NOT the sum
  // of per-week shortfalls. The budget tracker rolls an unfilled week's share
  // forward (remainingBudget only shrinks when hours actually land), so a
  // shortfall can be absorbed later — by a forceAssignment (forces deduct from
  // remainingBudget only) or by auto-placement in a later week. Summing
  // per-week shortfalls double-counted those rolled-forward hours and emitted
  // "could not be placed" warnings for fully-placed demand (Spencer Benchwork
  // 31.5h force, job 11835189937). The last week's perWeek equals the entire
  // remaining budget, so anything genuinely unplaceable survives here.
  return { placements: allPlacements, unplaced: Number(remainingBudget.toFixed(2)), rejections: allRejections, warnings: allWarnings };
}

// ============================================================================
// MAIN PLANNER
// ============================================================================

// `opts.savePath` controls the on-disk plan file:
//   - undefined (default): save to logs/rebalance-plan-<today>.json
//   - null:                skip the save entirely (tests pass this to avoid
//                          polluting the production logs/ path — see the
//                          2026-05-25 incident where test-overrides-read-
//                          pipeline.js's runPlan() call overwrote a real
//                          iter-11 plan with B5c synthetic-fixture data)
//   - <string path>:       save to that explicit path (tests can use a
//                          tempdir for isolation + per-test assertions)
async function runPlan(boards, opts = {}) {
  const { jobs, crewParents, timeOff, existingSubs, overrideRows = [] } = boards;

  console.log(`Loaded: ${jobs.length} jobs, ${crewParents.length} crew-week parents, ${timeOff.length} time off entries, ${existingSubs.length} existing subitems, ${overrideRows.length} active override row(s)`);

  // Report which overrides are active
  const overrideCount = Object.keys(OVERRIDES.jobOverrides || {}).length;
  const capacityOverrideWeeks = Object.keys(OVERRIDES.crewCapacityOverrides || {}).length;
  if (overrideCount > 0 || capacityOverrideWeeks > 0) {
    console.log(`Applying ${overrideCount} job override(s), ${capacityOverrideWeeks} capacity override week(s)`);
  }

  // B4: translate Manual Overrides board rows into internal primitives + merge
  // with JSON-source forces/exclusions. Board wins on (jobId × station × week ×
  // crew) tuple match for forceAssignments; coarse JSON crewExclusions and
  // fine-grained board exclusions coexist (redundant overlap is logged but not
  // resolved — see mergeCrewExclusions docstring). Conflict logging is loud
  // so an operator scanning console output catches surprising shadowing.
  const translation = translateOverrideRows(overrideRows, jobs, crewParents);
  const forceMerge = mergeForceAssignments(OVERRIDES.forceAssignments || [], translation.forceAssignments);
  const exclMerge  = mergeCrewExclusions(OVERRIDES.crewExclusions || {}, translation.crewExclusions);
  if (overrideRows.length > 0 || translation.forceAssignments.length || translation.crewExclusions.length || translation.untranslatable.length) {
    console.log(`Override merge: ${translation.forceAssignments.length} board force(s), ${translation.crewExclusions.length} board exclusion(s), ${translation.untranslatable.length} untranslatable row(s)`);
  }
  if (forceMerge.conflicts.length > 0) {
    console.log(`\n=== OVERRIDE FORCE CONFLICTS (${forceMerge.conflicts.length}) — board wins ===`);
    for (const c of forceMerge.conflicts) {
      console.log(`  ${c.key}: JSON ${c.jsonSource.hours ?? '?'}h ('${c.jsonSource.reason || ''}') → board ${c.boardSource.hours ?? '?'}h (row ${c.boardSource._sourceRowId})`);
    }
  }
  if (exclMerge.conflicts.length > 0) {
    console.log(`\n=== OVERRIDE EXCLUSION REDUNDANCY (${exclMerge.conflicts.length}) — board row duplicates JSON coarse exclusion ===`);
    for (const c of exclMerge.conflicts) {
      console.log(`  ${c.crew} ⊅ ${c.jobId} (station ${c.station}, week ${c.week}): JSON='${c.jsonReason || ''}' board='${c.boardReason || ''}'`);
    }
  }
  if (translation.untranslatable.length > 0) {
    console.log(`\n=== UNTRANSLATABLE OVERRIDE ROWS (${translation.untranslatable.length}) — flagged for B5 validation ===`);
    for (const u of translation.untranslatable) {
      console.log(`  row ${u.rowId}: ${u.reason}`);
    }
  }
  // Activate merged forceAssignments + crewExclusions view; getForceAssignments()
  // and jobExclusionViolation() read from these for the duration of this run.
  // The try/finally further down restores both to null so a thrown error
  // doesn't leak module state into subsequent runs (matters for tests + the
  // B5 two-pass driver that calls runPlan back-to-back).
  activeForceAssignments = forceMerge.merged;
  activeCrewExclusions   = exclMerge.merged;
  try {

  // Filter to active jobs (Not Started or Scheduled)
  // 'Ready to Ship' (derived when all production stations are marked done)
  // stays ACTIVE — only P&S/Delivery remain to plan for such jobs.
  const activeJobs = jobs.filter(j => ['Not Started', 'Scheduled', 'Ready to Schedule', 'Finishing', 'Ready to Ship'].includes(j.status));
  console.log(`Active jobs to schedule: ${activeJobs.length}`);

  // Sort jobs by delivery date ascending (soonest first gets priority)
  activeJobs.sort((a, b) => (a.delivery || 'Z').localeCompare(b.delivery || 'Z'));

  // Planning window: this week through 4 weeks past the last delivery (or 12 weeks out, whichever is further).
  // A1: dynamic horizon — replaces previously hardcoded `'2026-07-27'`. Removes the manual maintenance burden
  // of bumping endWeek every time a job has a far-future delivery (Atom Computing 8/08 forced the last edit).
  const today = new Date();
  const startWeek = toISO(getMondayOfWeek(today));

  const deliveryDates = activeJobs.map(j => j.delivery).filter(Boolean);
  const maxDelivery = deliveryDates.length > 0
    ? deliveryDates.reduce((m, d) => d > m ? d : m)
    : null;
  const horizonFromDeliveries = maxDelivery
    ? toISO(getMondayOfWeek(addDays(parseISO(maxDelivery), 28)))
    : null;
  const horizonFloor = toISO(getMondayOfWeek(addDays(today, 84)));
  const endWeek = horizonFromDeliveries && horizonFromDeliveries > horizonFloor
    ? horizonFromDeliveries
    : horizonFloor;

  const weeks = getWeekList(startWeek, endWeek);
  console.log(`Planning horizon: ${startWeek} → ${endWeek} (${weeks.length} weeks${maxDelivery ? `, max delivery ${maxDelivery}` : ', no active jobs — using 12-week floor'})`);

  // A4: validate every (crew × week) in the horizon has a parent row on the
  // Crew Allocation board. Without this, forces silently skip when a parent is
  // missing (the bug that took 8 plan iterations on 2026-05-02). Skip subcontractor
  // virtual-crew (no parent rows by design) and Bob pre-BOB_START_DATE.
  const subcontractorNames = new Set();
  for (const subs of Object.values(OVERRIDES.subcontractors || {})) {
    for (const s of subs) subcontractorNames.add(s.name);
  }
  const missingParents = findMissingCrewParents({
    crewParents,
    weeks,
    crews: Object.keys(CREW_BASE_HOURS),
    subcontractorNames,
    crewStartDates: { Bob: BOB_START_DATE },
    crewEndDates: CREW_END_DATES,
  });
  if (missingParents.length > 0) {
    if (AUTO_CREATE_PARENTS) {
      console.log(`\n=== AUTO-CREATING ${missingParents.length} CREW PARENT ROW(S) ===`);
      const created = await autoCreateCrewParents(missingParents, gql);
      for (const c of created) {
        console.log(`  ✓ Created parent row for ${c.crew} @ ${c.week} (id=${c.id})`);
        crewParents.push({
          parentId: c.id,
          week: c.week,
          crew: c.crew,
          base: CREW_BASE_HOURS[c.crew] ?? 0,
          timeOff: 0,
          nonProd: 0,
        });
      }
    } else {
      console.error(`\n❌ Missing ${missingParents.length} required Crew Allocation parent row(s):`);
      for (const m of missingParents) {
        console.error(`  - ${m.crew} @ week of ${m.week}`);
      }
      console.error(`\nFix manually on the Crew Allocation board, OR rerun with --auto-create-parents.`);
      process.exit(1);
    }
  }

  // Build set of Master PM IDs for active jobs (their subitems will be deleted/rescheduled)
  const activeJobMasterPmIds = new Set(activeJobs.map(j => j.masterPmId).filter(Boolean));
  const grid = buildCapacityGrid(crewParents, timeOff, weeks, existingSubs, activeJobMasterPmIds);

  const allPlacements = [];
  const warnings = [];
  // A3: per-job finishing-cycle rows + skip count for the validation report
  const finishingCycleRows = [];
  let finishingCycleSkipped = 0;
  // A5: per-job PL-board finish-date writebacks. One entry per active job with
  // computed windows; dates null for pLam / finishingDays=0 / missing (executor
  // clears those PL columns rather than leaving them stale).
  const finishDateWritebacks = [];

  for (const job of activeJobs) {
    // PATCH D: skip jobs in the skipJobs list
    if (OVERRIDES.skipJobs?.includes(job.id)) {
      console.log(`Skipping ${job.name} per overrides.skipJobs`);
      finishingCycleSkipped++;
      continue;
    }
    if (!job.delivery) {
      warnings.push(`Job ${job.name} has no delivery date — skipping`);
      finishingCycleSkipped++;
      continue;
    }
    const windows = computeWindows(job);
    if (!windows) {
      warnings.push(`Could not compute windows for ${job.name}`);
      finishingCycleSkipped++;
      continue;
    }

    // A5: build PL-board finish-date writeback for this job (dates or nulls).
    finishDateWritebacks.push(buildFinishDateWriteback(job, windows));

    // A3: build finishing-cycle row (or count skip) for this job
    const fcRow = buildFinishingCycleRow(job, windows);
    if (fcRow.kind === 'row') {
      finishingCycleRows.push({
        jobId: fcRow.jobId,
        jobName: fcRow.jobName,
        finishingDays: fcRow.finishingDays,
        prefinEnd: fcRow.prefinEnd,
        postfinStart: fcRow.postfinStart,
        finishDrop: fcRow.finishDrop,
        finishReturn: fcRow.finishReturn,
        gap: fcRow.gap,
        valid: fcRow.valid,
        errors: fcRow.errors,
      });
    } else {
      finishingCycleSkipped++;
    }

    const stations = [
      { name: 'Engineering', hours: job.hours.eng, win: windows.eng },
      { name: 'Panel Processing', hours: job.hours.panel, win: windows.panel },
      { name: 'Benchwork', hours: job.hours.bench, win: windows.bench },
      { name: 'Pre Fin Cab Assembly', hours: job.hours.prefin, win: windows.prefin },
      { name: 'Post Fin Cab Assembly', hours: job.hours.postfin, win: windows.postfin },
    ];

    for (const s of stations) {
      if (!s.win || s.hours <= 0) continue;
      const result = scheduleStation(grid, job, s.name, s.hours, s.win.start, s.win.end);
      allPlacements.push(...result.placements);
      for (const w of result.warnings || []) warnings.push(w);
      if (result.unplaced > 0) {
        let msg = `${job.name} / ${s.name}: ${result.unplaced} hrs could not be placed within window ${s.win.start} → ${s.win.end}`;
        if (result.rejections && result.rejections.size > 0) {
          const blocked = Array.from(result.rejections.entries()).map(([c, r]) => `${c} (${r})`).join('; ');
          msg += ` — blocked candidates: ${blocked}`;
        }
        warnings.push(msg);
      }
    }

    // Pack & Ship + Delivery (2 hrs each on Paisios, delivery week)
    for (const ps of ['Pack & Ship', 'Delivery']) {
      const wk = windows.packShip.start;
      // PATCH 4: Apply force assignments first, then route remainder normally
      const forceResult = applyForceAssignments(grid, job, ps, wk, 2);
      allPlacements.push(...forceResult.placements);
      for (const w of forceResult.warnings) warnings.push(w);
      const remaining = Math.max(0, 2 - forceResult.hoursConsumed);
      if (remaining > 0) {
        const result = allocateStationWeek(grid, job, ps, wk, remaining, ['Paisios', 'Ian', 'Spencer', 'Bob', 'Jonathan']);
        allPlacements.push(...result.placements);
        if (result.unplaced > 0) warnings.push(`${job.name} / ${ps}: ${result.unplaced} hrs unplaced on ${wk}`);
      }
    }
  }

  // Build summary report
  const finishingCycleReport = {
    rows: finishingCycleRows,
    skippedCount: finishingCycleSkipped,
    invalidCount: finishingCycleRows.filter(r => !r.valid).length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'plan',
    jobsScheduled: activeJobs.length,
    totalPlacements: allPlacements.length,
    warnings,
    capacityGrid: {},
    placements: allPlacements,
    finishingCycleReport,
    finishDateWritebacks,
    // AUDIT FIX (2026-06-11): delete only where this plan holds a
    // replacement — see computeSubitemDeletes. The old activeJobs match had
    // two data-loss vectors: null===null matched every UNLINKED subitem on
    // the board, and active-but-unplanned jobs (missing delivery, all
    // windows past) lost their subitems with nothing re-created.
    existingSubitemIdsToDelete: computeSubitemDeletes(existingSubs, allPlacements),
  };

  // Build visual capacity summary
  for (const crew of Object.keys(grid)) {
    report.capacityGrid[crew] = {};
    for (const wk of weeks) {
      const slot = grid[crew][wk];
      if (!slot) continue;  // subcontractor virtual-crew rows only exist on one week
      // Include the cell if there's work, capacity, OR PTO that zeroed it out
      if (slot.committed > 0 || slot.available > 0 || slot.timeOff > 0) {
        // Per-cell assignment breakdown — paired with the committedAudit invariant
        // below for forensics. preExisting entries appear nowhere else in the plan
        // JSON, so this is the only place they're visible at the cell level.
        report.capacityGrid[crew][wk] = {
          avail: slot.available,
          committed: Number(slot.committed.toFixed(2)),
          timeOff: slot.timeOff || 0,
          over: slot.committed > slot.available * SOFT_CAP_MULTIPLIER
            ? Number((slot.committed - slot.available).toFixed(2))
            : 0,
          assignments: slot.assignments.map(a => ({
            job: a.job,
            station: a.station,
            hours: Number((a.hours || 0).toFixed(2)),
            ...(a.forced ? { forced: true } : {}),
            ...(a.preExisting ? { preExisting: true } : {}),
          })),
        };
      }
    }
  }

  // Bug 5 instrumentation: per (crew, week), verify slot.committed equals
  // sum(allPlacements where p.crew=crew & p.week=wk & !isSub) + sum(preExisting).
  // Any mismatch is a write-without-placement leak. Emitted to console + saved
  // into report.committedAuditMismatches for diffing in the saved plan.
  {
    const placementSums = new Map();  // `${crew}|${wk}` → hours
    for (const p of allPlacements) {
      if (p.isSubcontractor) continue;
      const key = `${p.crew}|${p.week}`;
      placementSums.set(key, (placementSums.get(key) || 0) + p.hours);
    }
    const mismatches = [];
    for (const crew of Object.keys(grid)) {
      for (const wk of weeks) {
        const slot = grid[crew]?.[wk];
        if (!slot) continue;
        if (slot.subcontractor) continue;  // virtual sub crews not in placementSums
        const placed = placementSums.get(`${crew}|${wk}`) || 0;
        const preExisting = (slot.assignments || [])
          .filter(a => a.preExisting)
          .reduce((s, a) => s + (a.hours || 0), 0);
        const expected = placed + preExisting;
        const delta = slot.committed - expected;
        if (Math.abs(delta) > 0.01) {
          mismatches.push({
            crew, week: wk,
            committed: Number(slot.committed.toFixed(2)),
            placed: Number(placed.toFixed(2)),
            preExisting: Number(preExisting.toFixed(2)),
            phantom: Number(delta.toFixed(2)),
            assignments: slot.assignments.map(a => ({
              job: a.job, station: a.station, hours: Number((a.hours || 0).toFixed(2)),
              ...(a.forced ? { forced: true } : {}),
              ...(a.preExisting ? { preExisting: true } : {}),
            })),
          });
        }
      }
    }
    report.committedAuditMismatches = mismatches;
    if (mismatches.length > 0) {
      console.log(`\n=== COMMITTED-AUDIT MISMATCHES (${mismatches.length}) ===`);
      console.log('committed != sum(placements) + sum(preExisting) → phantom hours');
      for (const m of mismatches) {
        console.log(`  ${m.crew} ${m.week}: committed=${m.committed} placed=${m.placed} preExisting=${m.preExisting} phantom=${m.phantom}`);
      }
    }
  }

  // Save plan file (unless opts.savePath === null — see runPlan docstring).
  const savePath = opts.savePath === undefined
    ? path.join(__dirname, '..', 'logs', `rebalance-plan-${toISO(new Date())}.json`)
    : opts.savePath;
  if (savePath !== null) {
    const saveDir = path.dirname(savePath);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(savePath, JSON.stringify(report, null, 2));
  }

  // Console summary
  console.log('\n=== CAPACITY GRID ===');
  for (const crew of Object.keys(report.capacityGrid)) {
    const weekData = report.capacityGrid[crew];
    const lines = [];
    for (const wk of Object.keys(weekData)) {
      const d = weekData[wk];
      const marker = d.over > 0 ? ' 🚨' : d.committed / d.avail > 0.9 ? ' 🟡' : '';
      lines.push(`  ${wk}: ${d.committed}/${d.avail}${marker}`);
    }
    if (lines.length) {
      console.log(`\n${crew}:`);
      lines.forEach(l => console.log(l));
    }
  }

  console.log('\n=== WARNINGS ===');
  if (warnings.length === 0) console.log('  None ✅');
  else warnings.forEach(w => console.log(`  ⚠️  ${w}`));

  // A3: finishing-cycle validation table
  console.log('\n=== FINISHING CYCLE VALIDATION ===');
  if (finishingCycleReport.rows.length === 0) {
    console.log('  No non-pLam jobs with finishing days in this plan.');
  } else {
    for (const r of finishingCycleReport.rows) {
      const mark = r.valid ? '✓' : '❌';
      console.log(
        `  ${mark} ${r.jobName}  prefin end ${r.prefinEnd}  finishingDays ${r.finishingDays}  postfin start ${r.postfinStart}  gap ${r.gap} BD`
      );
      if (!r.valid) {
        for (const e of r.errors) console.log(`      - ${e}`);
      }
    }
  }
  if (finishingCycleReport.skippedCount > 0) {
    console.log(`  (${finishingCycleReport.skippedCount} skipped — pLam, no delivery, or no finishing cycle)`);
  }
  if (finishingCycleReport.invalidCount > 0) {
    console.log(`  ⚠️  ${finishingCycleReport.invalidCount} invalid cycle(s) — --execute will refuse to run without --force.`);
  }

  // PATCH 1: Subcontractor usage summary
  const subUsage = new Map();
  for (const p of allPlacements) {
    if (!p.isSubcontractor) continue;
    const key = `${p.week}|${p.crew}`;
    if (!subUsage.has(key)) subUsage.set(key, { used: 0, jobs: new Set() });
    const entry = subUsage.get(key);
    entry.used += p.hours;
    entry.jobs.add(p.jobName);
  }
  if (subUsage.size > 0) {
    console.log('\n=== SUBCONTRACTOR USAGE ===');
    for (const [key, info] of subUsage.entries()) {
      const [week, name] = key.split('|');
      const pool = grid[name]?.[week]?.base || 0;
      const jobsList = Array.from(info.jobs).join(', ');
      console.log(`  ${week} ${name}: ${info.used.toFixed(1)}/${pool} hrs — ${jobsList}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total placements: ${allPlacements.length}`);
  console.log(`Existing subitems to delete: ${report.existingSubitemIdsToDelete.length}`);
  if (savePath !== null) console.log(`Plan saved to: ${savePath}`);
  console.log(`\nTo execute this plan: node scripts/rebalance-schedule.js --execute`);

  return report;
  } finally {
    activeForceAssignments = null;
    activeCrewExclusions   = null;
  }
}

// ============================================================================
// EXECUTE MODE — applies the most recent plan
// ============================================================================

// Returns the basename of the most-recent rebalance-plan-*.json in logsDir,
// or null if none exists. Filter requires literal `.json` suffix so stray
// `.bak` / `.tmp` / `.old` siblings can't outrank the canonical file in
// reverse-sorted order. See 2026-05-10 incident commit body for the bug
// this prevents — a `.bak` file in logs/ caused execute() to load stale
// data and start deleting subitems before TaskStop fired.
// AUDIT FIX (2026-06-11) — execute delete-guard. Delete a subitem ONLY when
// its job actually received placements in THIS plan: full-overwrite applies
// solely where we hold a replacement. Null/missing Master-PM links never
// match anything (the old null===null path queued every unlinked subitem on
// the board for deletion). Complete-job records and active-but-unplanned
// jobs are preserved.
function computeSubitemDeletes(existingSubs, placements) {
  const replanned = new Set(
    (placements || [])
      .map(p => p.masterPmId)
      .filter(id => id !== null && id !== undefined)
      .map(String));
  return (existingSubs || [])
    .filter(s => s.masterPmId !== null && s.masterPmId !== undefined && replanned.has(String(s.masterPmId)))
    .map(s => s.id);
}

function findLatestPlanFile(logsDir) {
  // AUDIT FIX (2026-06-11): strict date pattern only. The loose
  // startsWith/endsWith filter let 'rebalance-plan-pre-backfill-snapshot.json'
  // sort lexically after every dated plan ('p' > '2') and become the file the
  // next --execute would load.
  const files = fs.readdirSync(logsDir)
    .filter(f => /^rebalance-plan-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? files[0] : null;
}

// Caller (CLI orchestrator or future B5 validation pipeline) is responsible for
// loading `plan` — typically from the latest logs/rebalance-plan-*.json. The
// `boards` param is accepted for symmetry with runPlan and to give downstream
// phases (Phase 2 outputs, B6 row-status writeback) a hook for monday-side data
// without changing the signature. Currently unused inside the function body.
async function runExecute(plan, boards) {
  console.log(`Plan generated: ${plan.generatedAt}`);
  console.log(`Placements: ${plan.placements.length}, Deletes: ${plan.existingSubitemIdsToDelete.length}`);

  // A3: refuse to execute if any finishing-cycle row in the plan is invalid,
  // unless --force is set.
  const gate = checkExecuteGate(plan, { force: FORCE });
  if (gate.bypassed) {
    console.log(`\n⚠️  Bypassing ${gate.invalidRows.length} finishing-cycle invalid row(s) per --force:`);
    for (const r of gate.invalidRows) {
      console.log(`   - ${r.jobName}: ${(r.errors || []).join('; ')}`);
    }
  } else if (gate.block) {
    console.error(`\n❌ ${gate.invalidRows.length} finishing-cycle invalid row(s) in latest plan:`);
    for (const r of gate.invalidRows) {
      console.error(`   - ${r.jobName}: ${(r.errors || []).join('; ')}`);
    }
    // AUDIT/DEPLOY FIX (2026-06-11): throw instead of process.exit(1) so
    // in-process callers (planner-trigger deploy flow) can catch and report;
    // the CLI .catch path produces the same exit-1 behavior.
    throw new Error(`execute gate blocked: ${gate.invalidRows.length} finishing-cycle invalid row(s) — fix windows/delivery dates or rerun with --force`);
  }

  console.log('\nThis will DELETE all existing subitems for active jobs and CREATE new ones per plan.');
  console.log('Waiting 5 seconds before proceeding — press Ctrl+C to abort...');
  await new Promise(r => setTimeout(r, 5000));

  // Delete existing subitems
  console.log('\nDeleting existing subitems...');
  let deleted = 0;
  for (const id of plan.existingSubitemIdsToDelete) {
    try {
      await gql(`mutation { delete_item(item_id: ${id}) { id } }`);
      deleted++;
    } catch (e) {
      console.error(`Failed to delete ${id}:`, e.message);
    }
    if (deleted % 10 === 0) console.log(`  Deleted ${deleted}/${plan.existingSubitemIdsToDelete.length}`);
  }
  console.log(`Deleted ${deleted} subitems.`);

  // Create new subitems
  console.log('\nCreating new subitems...');
  let created = 0;
  let subSkipped = 0;
  for (const p of plan.placements) {
    if (p.isSubcontractor) { subSkipped++; continue; }  // PATCH 1: subs are ops-only, no monday subitem
    const stationId = STATION_IDS[p.station];
    const personId = CREW_PERSON_ID[p.crew];
    const personPart = personId ? `,\"person\":{\"personsAndTeams\":[{\"id\":${personId},\"kind\":\"person\"}]}` : '';
    const cv = `{\"dropdown_mm2kex19\":{\"ids\":[${stationId}]},\"board_relation_mm2kchhq\":{\"item_ids\":[${p.masterPmId}]},\"numeric_mm2kv7rq\":${p.hours},\"text_mm2mpjcn\":\"${p.crew}\"${personPart}}`;
    const name = `${p.jobName} — ${p.station}`;
    const mutation = `mutation {
      create_subitem(
        parent_item_id: ${p.parentId},
        item_name: ${JSON.stringify(name)},
        column_values: ${JSON.stringify(cv)}
      ) { id }
    }`;
    try {
      await gql(mutation);
      created++;
    } catch (e) {
      console.error(`Failed to create subitem for ${name}:`, e.message);
    }
    if (created % 10 === 0) console.log(`  Created ${created}/${plan.placements.length}`);
  }
  console.log(`Created ${created} subitems.`);
  if (subSkipped > 0) console.log(`Skipped ${subSkipped} subcontractor placement(s) — no monday subitem created (ops-tracked only).`);

  // A5: write computed finishDrop / finishReturn back to the Production Load
  // Board so the columns stop going stale after every --execute (iter-8 pain).
  // pLam / finishingDays=0 jobs get nulls (clear the columns).
  const finishMutations = buildFinishDateMutations(plan);
  let writeOk = 0;
  let writeFail = 0;
  if (finishMutations.length > 0) {
    console.log(`\nWriting finish dates to Production Load Board (${finishMutations.length} job(s))...`);
    for (const m of finishMutations) {
      const cvStr = JSON.stringify(m.columnValues).replace(/"/g, '\\"');
      const mutation = `mutation {
        change_multiple_column_values(
          item_id: ${m.plItemId},
          board_id: ${BOARD_PL},
          column_values: "${cvStr}"
        ) { id }
      }`;
      try {
        await gql(mutation);
        writeOk++;
      } catch (e) {
        writeFail++;
        console.error(`Failed to write finish dates for PL item ${m.plItemId}:`, e.message);
      }
    }
    console.log(`Finish-date writeback: ${writeOk} ok${writeFail > 0 ? `, ${writeFail} failed` : ''}.`);
  }

  console.log('\n✅ Execution complete.');
  // DEPLOY (2026-06-11): counts for the trigger's run summary.
  return { deleted, created, subSkipped, finishWrites: { ok: writeOk, fail: writeFail } };
}

// ============================================================================
// A4 — CREW PARENT ROW VALIDATION
// ============================================================================

// Pure: given the parent rows fetched from Crew Allocation, the planning-horizon
// week list, and the crew roster, return every (crew × week) pair that lacks a
// parent row. Skips:
//   - subcontractor virtual-crew (no parent rows by design — they're injected
//     into the capacity grid for one week only via OVERRIDES.subcontractors)
//   - any (crew, week) pair where week < crewStartDates[crew]
//     (e.g., Bob pre-2026-05-18 — subcontract-only before then)
function findMissingCrewParents({
  crewParents,
  weeks,
  crews,
  subcontractorNames = new Set(),
  crewStartDates = {},
  crewEndDates = {},
}) {
  const present = new Set();
  for (const cp of crewParents) {
    present.add(`${cp.crew}|${cp.week}`);
  }
  const missing = [];
  for (const crew of crews) {
    if (subcontractorNames.has(crew)) continue;
    const startDate = crewStartDates[crew];
    const endDate = crewEndDates[crew];
    for (const week of weeks) {
      if (startDate && week < startDate) continue;
      if (endDate && week >= endDate) continue;  // departed — no row needed/created
      if (!present.has(`${crew}|${week}`)) {
        missing.push({ crew, week });
      }
    }
  }
  return missing;
}

// Fires one create_item mutation per missing entry against BOARD_CREW_ALLOC.
// gqlFn is injected so tests can stub without hitting live monday.
//
// TODO(phase 3): when audit logging + notification surfaces land (see
// docs/phase-1-manual-overrides-plan.md §E.1), flip plan() default to
// "auto-create with loud log" and remove the --auto-create-parents opt-in.
async function autoCreateCrewParents(missing, gqlFn, opts = {}) {
  const boardId = opts.boardId ?? BOARD_CREW_ALLOC;
  const baseHoursMap = opts.baseHours ?? CREW_BASE_HOURS;
  const personIdMap = opts.personIds ?? CREW_PERSON_ID;
  const peopleColId = opts.peopleColId ?? 'multiple_person_mm2kr7ky';

  const mutation = `mutation($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
    create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
  }`;

  const created = [];
  for (const m of missing) {
    const [, mm, dd] = m.week.split('-');
    const itemName = `${m.crew} — Week of ${mm}/${dd}`;
    const cv = {
      [COL_CA.weekDate]: { date: m.week },
      [COL_CA.baseHours]: baseHoursMap[m.crew] ?? 0,
    };
    if (personIdMap[m.crew]) {
      cv[peopleColId] = { personsAndTeams: [{ id: personIdMap[m.crew], kind: 'person' }] };
    }
    const res = await gqlFn(mutation, {
      boardId: String(boardId),
      itemName,
      columnValues: JSON.stringify(cv),
    });
    created.push({ crew: m.crew, week: m.week, id: res?.create_item?.id ?? null });
  }
  return created;
}

// ============================================================================
// EXPORTS — pure helpers + computeWindows callable from tests / sibling modules
// without triggering CLI entry. CLI invocations (require.main === module) keep
// the original token check + IIFE.
// ============================================================================

module.exports = {
  gql,
  loadAll,
  loadOverridesBoard,
  runPlan,
  runExecute,
  // PATCH-3 hard rules, exported so validate-overrides.js can reject a
  // force at validation time instead of letting applyForceAssignments
  // throw mid-pass-2 (2026-06-10 smoke-test finding).
  hardRuleViolation,
  // Routing matrices exported for tests (synthetic multi-primary injection
  // in test-multi-primary-spillover.js) and matrix-vs-doc validation tooling.
  ROUTING,
  SECONDARY,
  // Stations-Complete tracking (2026-06-11).
  computeRemainingHours,
  isValidHrsLeft,
  parseHrsLeftCell,
  shopProgressWarnings,
  isReadyToShip,
  STATION_LABEL_TO_KEY,
  // Audit fixes (2026-06-11).
  computeSubitemDeletes,
  // Overrides config exported for tests (synthetic forceAssignment injection
  // in test-force-unplaced-accounting.js — getForceAssignments falls back to
  // OVERRIDES.forceAssignments when no runPlan merge is active).
  OVERRIDES,
  translateOverrideRows,
  mergeForceAssignments,
  mergeCrewExclusions,
  computeWindows,
  parseISO,
  toISO,
  addDays,
  addBusinessDays,
  businessDaysBack,
  getMondayOfWeek,
  weeksCountForHours,
  findMissingCrewParents,
  autoCreateCrewParents,
  BOARD_CREW_ALLOC,
  findLatestPlanFile,
  checkFinishingCycleValid,
  assertFinishingCycleValid,
  buildFinishingCycleRow,
  checkExecuteGate,
  businessDaysBetween,
  buildFinishDateWriteback,
  buildFinishDateMutations,
  scheduleStation,
  allocateStationWeek,
  SOFT_CAP_MULTIPLIER,
};

// ============================================================================
// ENTRY POINT
// ============================================================================

if (require.main === module) {
  if (!TOKEN) {
    console.error('ERROR: MONDAY_API_TOKEN env var required');
    process.exit(1);
  }
  (async () => {
    try {
      if (MODE === 'plan') {
        console.log('=== HTW Rebalancer — PLAN mode ===');
        console.log('Loading data from monday.com...');
        const boards = await loadAll();
        await runPlan(boards);
      } else {
        console.log('=== HTW Rebalancer — EXECUTE mode ===');
        const logsDir = path.join(__dirname, '..', 'logs');
        const fname = findLatestPlanFile(logsDir);
        if (!fname) {
          console.error('No plan file found. Run with --plan first.');
          process.exit(1);
        }
        const planFile = path.join(logsDir, fname);
        console.log(`Loading plan: ${planFile}`);
        const planObj = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        await runExecute(planObj, null);
      }
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
