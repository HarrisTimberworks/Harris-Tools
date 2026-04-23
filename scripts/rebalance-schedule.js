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

if (!TOKEN) {
  console.error('ERROR: MONDAY_API_TOKEN env var required');
  process.exit(1);
}

const MODE = process.argv.includes('--execute') ? 'execute' : 'plan';

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
};

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

// Soft capacity ceiling — allow 5% over before flagging as overload
const SOFT_CAP_MULTIPLIER = 1.05;

// ============================================================================
// ROUTING MATRIX — keyed by [Job Subtype][Station] → array of Primary crew
// ============================================================================

const ROUTING = {
  'Res - Face Frame': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Spencer'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Ian', 'Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Res - Frameless': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Ian'],
    'Pre Fin Cab Assembly':   ['Ian'],
    'Post Fin Cab Assembly':  ['Ian', 'Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Commercial': {
    'Engineering':            ['Jonathan'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Ian'],
    'Pre Fin Cab Assembly':   ['Ian'],
    'Post Fin Cab Assembly':  ['Ian', 'Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Countertop/Surface': {
    'Engineering':            ['Jonathan'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Ian'],
    'Pre Fin Cab Assembly':   ['Ian'],
    'Post Fin Cab Assembly':  ['Ian', 'Bob'],
    'Pack & Ship':            ['Paisios'],
    'Delivery':               ['Paisios'],
  },
  'Mixed': {
    'Engineering':            ['Chris'],
    'Panel Processing':       ['Ken'],
    'Benchwork':              ['Spencer'],
    'Pre Fin Cab Assembly':   ['Spencer'],
    'Post Fin Cab Assembly':  ['Ian', 'Bob'],
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
    'Benchwork':              ['Ian', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly':   ['Ian', 'Bob', 'Paisios', 'Ken'],  // Ken as last resort
    'Post Fin Cab Assembly':  ['Spencer', 'Paisios'],
    'Engineering':            ['Paisios', 'Jonathan'],
  },
  'Res - Frameless': {
    'Benchwork':              ['Spencer', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly':   ['Spencer', 'Bob', 'Paisios', 'Ken'],
    'Post Fin Cab Assembly':  ['Spencer', 'Paisios'],
    'Panel Processing':       ['Ian', 'Bob'],
  },
  'Commercial': {
    'Benchwork':              ['Spencer', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly':   ['Spencer', 'Bob', 'Paisios', 'Ken'],
    'Post Fin Cab Assembly':  ['Spencer', 'Paisios', 'Ken'],  // Ken OK for commercial PostFin
    'Panel Processing':       ['Ian', 'Bob'],
  },
  'Countertop/Surface': {
    'Benchwork':              ['Bob', 'Spencer'],
    'Post Fin Cab Assembly':  ['Spencer', 'Paisios'],
    'Panel Processing':       ['Bob'],
  },
  'Mixed': {
    'Benchwork':              ['Ian', 'Bob', 'Paisios'],
    'Pre Fin Cab Assembly':   ['Ian', 'Bob', 'Paisios', 'Ken'],
    'Post Fin Cab Assembly':  ['Spencer', 'Paisios'],
    'Engineering':            ['Paisios', 'Jonathan'],
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

async function loadJobs() {
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
  const data = await gql(q);
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

    // If override specifies remainingHours, use those; null means "use formula as-is (full job)"
    const hours = override.remainingHours && override.remainingHours !== null
      ? override.remainingHours
      : formulaHours;

    return {
      id: it.id,
      name: it.name,
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

async function loadCrewParents() {
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
    const data = await gql(q, { cursor });
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

async function loadTimeOff() {
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
  const data = await gql(q);
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

async function loadSubitems() {
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
    const data = await gql(q, { cursor });
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

  // Apply time off from Time Off board (redundant guard in case rollup lagged)
  for (const to of timeOffList) {
    const personName = Object.keys(CREW_PERSON_ID).find(k => CREW_PERSON_ID[k] === to.personId);
    if (!personName || !grid[personName]) continue;
    const from = parseISO(to.from);
    const to_ = parseISO(to.to);
    let d = from;
    while (d <= to_) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const wkStart = toISO(getMondayOfWeek(d));
        if (grid[personName][wkStart]) {
          const entry = grid[personName][wkStart];
          const expectedBaseAfterThisDay = entry.base - 8;
          if (entry.available > expectedBaseAfterThisDay) {
            entry.available = Math.max(0, entry.available - 8);
            entry.timeOff += 8;
          }
        }
      }
      d = addDays(d, 1);
    }
  }

  // Bob pre-5/18 is subcontract-only, not salaried
  for (const wk of weeks) {
    if (wk < BOB_START_DATE) {
      grid.Bob[wk].available = 0;
      grid.Bob[wk].base = 0;
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

  // Finish cycle (only if Finishing Days > 0 and not P-Lam)
  let finishDrop = null, finishReturn = null;
  if (job.finishingDays > 0 && !job.pLam) {
    const finishReturnRef = job.hours.postfin > 0 ? (windows.postfin?.start || deliveryWeek) : deliveryWeek;
    finishReturn = toISO(addDays(parseISO(finishReturnRef), 4));
    finishDrop = businessDaysBack(finishReturn, job.finishingDays);
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
      const prefinEndTarget = finishDrop
        ? toISO(addDays(parseISO(finishDrop), -1))
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
            ? toISO(addDays(parseISO(finishDrop), -1))
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

  return windows;
}

/**
 * Allocate hours to a specific week+crew. Spreads over multiple candidates if
 * the Primary is at capacity.
 */
function allocateStationWeek(grid, job, station, week, hours, candidates) {
  const placements = [];
  let remaining = hours;

  for (const crew of candidates) {
    if (remaining <= 0) break;
    if (!grid[crew]?.[week]) continue;
    if (!grid[crew][week].parentId) continue;  // no parent row means skip
    const slot = grid[crew][week];
    const softCap = slot.available * SOFT_CAP_MULTIPLIER;
    const room = Math.max(0, softCap - slot.committed);
    if (room <= 0) continue;
    const toPlace = Math.min(remaining, room);
    placements.push({
      crew,
      week,
      hours: Number(toPlace.toFixed(2)),
      parentId: slot.parentId,
      station,
      jobId: job.id,
      jobName: job.name,
      masterPmId: job.masterPmId,
    });
    slot.committed += toPlace;
    slot.assignments.push({ job: job.name, station, hours: toPlace });
    remaining -= toPlace;
  }

  return { placements, unplaced: Number(remaining.toFixed(2)) };
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

  // Split hours evenly across weeks, then allocate each week
  const perWeek = hours / weeks.length;
  const allPlacements = [];
  let totalUnplaced = 0;

  for (const wk of weeks) {
    // For multi-primary (like Post Fin has Ian+Bob), split evenly among primaries first
    const primariesAvailableThisWeek = primary.filter(c => grid[c]?.[wk]?.parentId && grid[c][wk].available > 0);

    if (primariesAvailableThisWeek.length > 1) {
      // Split evenly among primaries
      const perPrimary = perWeek / primariesAvailableThisWeek.length;
      for (const p of primariesAvailableThisWeek) {
        const result = allocateStationWeek(grid, job, station, wk, perPrimary, [p, ...candidates.filter(c => c !== p)]);
        allPlacements.push(...result.placements);
        totalUnplaced += result.unplaced;
      }
    } else {
      const result = allocateStationWeek(grid, job, station, wk, perWeek, candidates);
      allPlacements.push(...result.placements);
      totalUnplaced += result.unplaced;
    }
  }

  return { placements: allPlacements, unplaced: totalUnplaced };
}

// ============================================================================
// MAIN PLANNER
// ============================================================================

async function plan() {
  console.log('=== HTW Rebalancer — PLAN mode ===');
  console.log('Loading data from monday.com...');

  const jobs = await loadJobs();
  const crewParents = await loadCrewParents();
  const timeOff = await loadTimeOff();
  const existingSubs = await loadSubitems();

  console.log(`Loaded: ${jobs.length} jobs, ${crewParents.length} crew-week parents, ${timeOff.length} time off entries, ${existingSubs.length} existing subitems`);

  // Report which overrides are active
  const overrideCount = Object.keys(OVERRIDES.jobOverrides || {}).length;
  const capacityOverrideWeeks = Object.keys(OVERRIDES.crewCapacityOverrides || {}).length;
  if (overrideCount > 0 || capacityOverrideWeeks > 0) {
    console.log(`Applying ${overrideCount} job override(s), ${capacityOverrideWeeks} capacity override week(s)`);
  }

  // Filter to active jobs (Not Started or Scheduled)
  const activeJobs = jobs.filter(j => ['Not Started', 'Scheduled', 'Ready to Schedule', 'Finishing'].includes(j.status));
  console.log(`Active jobs to schedule: ${activeJobs.length}`);

  // Sort jobs by delivery date ascending (soonest first gets priority)
  activeJobs.sort((a, b) => (a.delivery || 'Z').localeCompare(b.delivery || 'Z'));

  // Planning window: this week through end of July
  const today = new Date();
  const startWeek = toISO(getMondayOfWeek(today));
  const endWeek = '2026-07-27';
  const weeks = getWeekList(startWeek, endWeek);

  // Build set of Master PM IDs for active jobs (their subitems will be deleted/rescheduled)
  const activeJobMasterPmIds = new Set(activeJobs.map(j => j.masterPmId).filter(Boolean));
  const grid = buildCapacityGrid(crewParents, timeOff, weeks, existingSubs, activeJobMasterPmIds);

  const allPlacements = [];
  const warnings = [];

  for (const job of activeJobs) {
    // PATCH D: skip jobs in the skipJobs list
    if (OVERRIDES.skipJobs?.includes(job.id)) {
      console.log(`Skipping ${job.name} per overrides.skipJobs`);
      continue;
    }
    if (!job.delivery) {
      warnings.push(`Job ${job.name} has no delivery date — skipping`);
      continue;
    }
    const windows = computeWindows(job);
    if (!windows) {
      warnings.push(`Could not compute windows for ${job.name}`);
      continue;
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
      if (result.unplaced > 0) {
        warnings.push(`${job.name} / ${s.name}: ${result.unplaced} hrs could not be placed within window ${s.win.start} → ${s.win.end}`);
      }
    }

    // Pack & Ship + Delivery (2 hrs each on Paisios, delivery week)
    for (const ps of ['Pack & Ship', 'Delivery']) {
      const wk = windows.packShip.start;
      const result = allocateStationWeek(grid, job, ps, wk, 2, ['Paisios', 'Ian', 'Spencer', 'Bob', 'Jonathan']);
      allPlacements.push(...result.placements);
      if (result.unplaced > 0) warnings.push(`${job.name} / ${ps}: ${result.unplaced} hrs unplaced on ${wk}`);
    }
  }

  // Build summary report
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'plan',
    jobsScheduled: activeJobs.length,
    totalPlacements: allPlacements.length,
    warnings,
    capacityGrid: {},
    placements: allPlacements,
    existingSubitemIdsToDelete: existingSubs
      .filter(s => activeJobs.some(j => j.masterPmId === s.masterPmId))
      .map(s => s.id),
  };

  // Build visual capacity summary
  for (const crew of Object.keys(grid)) {
    report.capacityGrid[crew] = {};
    for (const wk of weeks) {
      const slot = grid[crew][wk];
      if (slot.committed > 0 || slot.available > 0) {
        report.capacityGrid[crew][wk] = {
          avail: slot.available,
          committed: Number(slot.committed.toFixed(2)),
          over: slot.committed > slot.available * SOFT_CAP_MULTIPLIER
            ? Number((slot.committed - slot.available).toFixed(2))
            : 0,
        };
      }
    }
  }

  // Save plan file
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const planFile = path.join(logsDir, `rebalance-plan-${toISO(new Date())}.json`);
  fs.writeFileSync(planFile, JSON.stringify(report, null, 2));

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

  console.log('\n=== SUMMARY ===');
  console.log(`Total placements: ${allPlacements.length}`);
  console.log(`Existing subitems to delete: ${report.existingSubitemIdsToDelete.length}`);
  console.log(`Plan saved to: ${planFile}`);
  console.log(`\nTo execute this plan: node scripts/rebalance-schedule.js --execute`);
}

// ============================================================================
// EXECUTE MODE — applies the most recent plan
// ============================================================================

async function execute() {
  console.log('=== HTW Rebalancer — EXECUTE mode ===');
  const logsDir = path.join(__dirname, '..', 'logs');
  const files = fs.readdirSync(logsDir).filter(f => f.startsWith('rebalance-plan-')).sort().reverse();
  if (files.length === 0) {
    console.error('No plan file found. Run with --plan first.');
    process.exit(1);
  }
  const planFile = path.join(logsDir, files[0]);
  console.log(`Loading plan: ${planFile}`);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  console.log(`Plan generated: ${plan.generatedAt}`);
  console.log(`Placements: ${plan.placements.length}, Deletes: ${plan.existingSubitemIdsToDelete.length}`);

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
  for (const p of plan.placements) {
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

  console.log('\n✅ Execution complete.');
}

// ============================================================================
// ENTRY POINT
// ============================================================================

(async () => {
  try {
    if (MODE === 'plan') await plan();
    else await execute();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
