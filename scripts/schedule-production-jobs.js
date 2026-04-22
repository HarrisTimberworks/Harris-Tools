#!/usr/bin/env node
/*
 * Production Job Scheduler v2 (every 15 min)
 *
 * 1. Finds Production Load Board jobs with status = "Ready to Schedule"
 * 2. Auto-calculates station windows from Delivery Date backwards
 * 3. Creates subitems on the Crew Allocation Board routed via the
 *    routing matrix (by Job Subtype)
 * 4. Flips status to "Scheduled"
 *
 * Lead time rules (backwards from Delivery Date):
 *   Pack & Ship / Delivery = Delivery Week
 *   Post Fin Cab Assembly  = scaled weeks, ends same week as Pack & Ship
 *   Finish Return Date     = Friday of Post Fin first week
 *   Finishing              = duration = Finishing Days column
 *   Finish Drop Date       = Friday of Pre Fin last week
 *   Pre Fin Cab Assembly   = scaled weeks, ends week before Finish Drop
 *   Benchwork              = scaled weeks, ends same week as Pre Fin last
 *   Panel Processing       = scaled weeks, ends week before Pre Fin start
 *   Engineering            = scaled weeks, ends week before Panel Proc start
 *
 * Hour scaling:
 *   <= 40 hrs: 1 week
 *   41-80:     2 weeks
 *   81-120:    3 weeks
 *   121+:      4 weeks
 */

const PROD_LOAD_BOARD = 18407601557;
const CREW_BOARD = 18409529791;
const SUBITEM_BOARD = 18409530171;
const MASTER_PM_BOARD = 9820786641;

// Production Load Board columns
const COL_PL_STATUS = 'color_mm26404x';
const COL_PL_SUBTYPE = 'color_mm26yes1';
const COL_PL_DELIVERY = 'lookup_mm2n4nf4';  // Mirror column from Master PM Board
const COL_PL_FINISHING_DAYS = 'numeric_mm2hdd1z';
const COL_PL_FINISH_DROP = 'date_mm26qqv3';
const COL_PL_FINISH_RETURN = 'date_mm2k17ef';
const COL_PL_MASTER_PM = 'board_relation_mm26mhea';

// Station hours (formulas on Production Load Board)
const COL_PL_ENG_HRS = 'formula_mm2dpf4n';
const COL_PL_PANEL_HRS = 'formula_mm2dxy2k';
const COL_PL_BENCH_HRS = 'formula_mm2d25dk';
const COL_PL_PREFIN_HRS = 'formula_mm2df4w1';
const COL_PL_POSTFIN_HRS = 'formula_mm2d5fmw';

// Station windows (week columns on Production Load Board)
const COL_PL_ENG_WINDOW = 'week_mm26ywqt';
const COL_PL_PANEL_WINDOW = 'week_mm26h520';
const COL_PL_BENCH_WINDOW = 'week_mm26v34w';
const COL_PL_PREFIN_WINDOW = 'week_mm26nywp';
const COL_PL_POSTFIN_WINDOW = 'week_mm26z8fz';
const COL_PL_PACKSHIP_WINDOW = 'week_mm26ykzx';

// Crew Allocation Board columns
const COL_CA_WEEK = 'date_mm2kjth4';
const COL_CA_CREW_TEXT = 'text_mm2mhm0y';

// Subitem board columns
const COL_SI_STATION = 'dropdown_mm2kex19';
const COL_SI_RELATED_JOB = 'board_relation_mm2kchhq';
const COL_SI_HOURS = 'numeric_mm2kv7rq';
const COL_SI_ASSIGNED_TEXT = 'text_mm2mpjcn';
const COL_SI_OWNER = 'person';

// Station dropdown label IDs (from subitem board)
const STATION_ID = {
  'Engineering': 1,
  'Panel Processing': 2,
  'Benchwork': 3,
  'Pre Fin Cab Assembly': 4,
  'Post Fin Cab Assembly': 5,
  'Pack & Ship': 6,
  'Delivery': 7,
};

// Bob's start date (ISO) — he's skipped before this
const BOB_START_DATE = '2026-05-18';

// Default Finishing duration (days) if the Finishing Days column is blank
const DEFAULT_FINISHING_DAYS = 7;

// Routing matrix: [subtype][station] => array of Primary crew names
const ROUTING = {
  'Res - Face Frame': {
    'Engineering': ['Chris'],
    'Panel Processing': ['Ken'],
    'Benchwork': ['Spencer'],
    'Pre Fin Cab Assembly': ['Spencer'],
    'Post Fin Cab Assembly': ['Ian', 'Bob'],
    'Pack & Ship': ['Paisios'],
    'Delivery': ['Paisios'],
  },
  'Res - Frameless': {
    'Engineering': ['Chris'],
    'Panel Processing': ['Ken'],
    'Benchwork': ['Ian'],
    'Pre Fin Cab Assembly': ['Ian'],
    'Post Fin Cab Assembly': ['Ian', 'Bob'],
    'Pack & Ship': ['Paisios'],
    'Delivery': ['Paisios'],
  },
  'Commercial': {
    'Engineering': ['Jonathan'],
    'Panel Processing': ['Ken'],
    'Benchwork': ['Ian'],
    'Pre Fin Cab Assembly': ['Ian'],
    'Post Fin Cab Assembly': ['Ian', 'Bob'],
    'Pack & Ship': ['Paisios'],
    'Delivery': ['Paisios'],
  },
  'Countertop/Surface': {
    'Engineering': ['Jonathan'],
    'Panel Processing': ['Ken'],
    'Benchwork': ['Ian'],
    'Pre Fin Cab Assembly': ['Ian'],
    'Post Fin Cab Assembly': ['Ian', 'Bob'],
    'Pack & Ship': ['Paisios'],
    'Delivery': ['Paisios'],
  },
  'Mixed': {
    'Engineering': ['Chris'],
    'Panel Processing': ['Ken'],
    'Benchwork': ['Spencer'],
    'Pre Fin Cab Assembly': ['Spencer'],
    'Post Fin Cab Assembly': ['Ian', 'Bob'],
    'Pack & Ship': ['Paisios'],
    'Delivery': ['Paisios'],
  },
};

// Name mapping: crew name -> monday.com user ID
const CREW_USER_ID = {
  'Chris': 77398023,
  'Jonathan': 78941017,
  'Paisios': 77398083,
  'Rob': 102500064,
  'Ian': 99508397,
  'Spencer': 97341714,
  'Bob': 100329892,
  // 'Ken' has no monday.com account
};

const API_URL = 'https://api.monday.com/v2';
const RATE_LIMIT_MS = 200;
const DRY_RUN = process.env.DRY_RUN === '1';
const TOKEN = process.env.MONDAY_API_TOKEN;

if (!DRY_RUN && !TOKEN) {
  console.error('ERROR: MONDAY_API_TOKEN not set.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
    body: JSON.stringify({ query }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// =========== DATE UTILITIES ===========

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function fridayOf(mondayStr) {
  const d = new Date(mondayStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4);
  return d.toISOString().slice(0, 10);
}

// Returns Monday N weeks before the input Monday
function weeksBeforeMonday(mondayStr, n) {
  const d = new Date(mondayStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (7 * n));
  return d.toISOString().slice(0, 10);
}

// Returns YYYY-MM-DD date N business days (not calendar) after startStr
function addBusinessDays(startStr, days) {
  const d = new Date(startStr + 'T12:00:00Z');
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

// Hour scaling rule
function weeksFromHours(hrs) {
  if (hrs <= 0) return 0;
  if (hrs <= 40) return 1;
  if (hrs <= 80) return 2;
  if (hrs <= 120) return 3;
  return 4;
}

// Returns list of Monday dates (YYYY-MM-DD) spanned by a window
function weeksInRange(startMonday, endMonday) {
  if (!startMonday || !endMonday) return [];
  const weeks = [];
  let cursor = startMonday;
  let safety = 0;
  while (cursor <= endMonday && safety < 52) {
    weeks.push(cursor);
    const d = new Date(cursor + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
    safety++;
  }
  return weeks;
}

function filterBob(crewList, weekDate) {
  if (weekDate >= BOB_START_DATE) return crewList;
  return crewList.filter(c => c !== 'Bob');
}

// =========== WINDOW CALCULATION ===========

// Given job details, returns an object with all station windows and key dates
function calculateWindows(deliveryDate, finishingDays, hours) {
  const deliveryMonday = mondayOf(deliveryDate);

  // Pack & Ship / Delivery = Delivery Week
  const packShipStart = deliveryMonday;
  const packShipEnd = deliveryMonday;  // 1 week

  // Post Fin Cab Assembly
  const postFinWeeks = weeksFromHours(hours.postFin);
  const postFinEnd = packShipStart;  // ends same week as Pack & Ship
  const postFinStart = postFinWeeks > 0
    ? weeksBeforeMonday(postFinEnd, postFinWeeks - 1)
    : null;

  // Finish Return Date = Friday of Post Fin first week
  const finishReturn = postFinStart ? fridayOf(postFinStart) : null;

  // Finish Drop Date = finishReturn - finishingDays (business days)
  // Working backwards from finishReturn
  let finishDrop = null;
  if (finishReturn) {
    const d = new Date(finishReturn + 'T12:00:00Z');
    let subtracted = 0;
    while (subtracted < finishingDays) {
      d.setUTCDate(d.getUTCDate() - 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) subtracted++;
    }
    finishDrop = d.toISOString().slice(0, 10);
  }

  // Pre Fin Cab Assembly
  const preFinWeeks = weeksFromHours(hours.preFin);
  const preFinEnd = finishDrop ? mondayOf(finishDrop) : null;
  const preFinStart = (preFinEnd && preFinWeeks > 0)
    ? weeksBeforeMonday(preFinEnd, preFinWeeks - 1)
    : null;

  // Benchwork (concurrent with Pre Fin, ends same week as Pre Fin end)
  const benchWeeks = weeksFromHours(hours.bench);
  const benchEnd = preFinEnd;
  const benchStart = (benchEnd && benchWeeks > 0)
    ? weeksBeforeMonday(benchEnd, benchWeeks - 1)
    : null;

  // Panel Processing = ends week before Pre Fin start
  const panelWeeks = weeksFromHours(hours.panel);
  const panelEnd = preFinStart ? weeksBeforeMonday(preFinStart, 1) : null;
  const panelStart = (panelEnd && panelWeeks > 0)
    ? weeksBeforeMonday(panelEnd, panelWeeks - 1)
    : null;

  // Engineering = ends week before Panel Processing start
  const engWeeks = weeksFromHours(hours.eng);
  const engEnd = panelStart ? weeksBeforeMonday(panelStart, 1) : null;
  const engStart = (engEnd && engWeeks > 0)
    ? weeksBeforeMonday(engEnd, engWeeks - 1)
    : null;

  return {
    eng:      { start: engStart, end: engEnd, weeks: engStart ? weeksInRange(engStart, engEnd) : [] },
    panel:    { start: panelStart, end: panelEnd, weeks: panelStart ? weeksInRange(panelStart, panelEnd) : [] },
    bench:    { start: benchStart, end: benchEnd, weeks: benchStart ? weeksInRange(benchStart, benchEnd) : [] },
    preFin:   { start: preFinStart, end: preFinEnd, weeks: preFinStart ? weeksInRange(preFinStart, preFinEnd) : [] },
    postFin:  { start: postFinStart, end: postFinEnd, weeks: postFinStart ? weeksInRange(postFinStart, postFinEnd) : [] },
    packShip: { start: packShipStart, end: packShipEnd, weeks: weeksInRange(packShipStart, packShipEnd) },
    finishDrop,
    finishReturn,
  };
}

// =========== MONDAY.COM API ===========

async function getReadyToScheduleJobs() {
  const q = `{
    boards(ids: [${PROD_LOAD_BOARD}]) {
      items_page(
        limit: 50,
        query_params: {
          rules: [
            { column_id: "${COL_PL_STATUS}", compare_value: ["Ready to Schedule"], operator: contains_terms }
          ]
        }
      ) {
        items {
          id
          name
          column_values {
            id
            text
            value
            ... on FormulaValue {
              display_value
            }
            ... on BoardRelationValue {
              linked_item_ids
            }
            ... on MirrorValue {
              display_value
            }
          }
        }
      }
    }
  }`;
  const d = await gql(q);
  return d.boards[0].items_page.items;
}

async function getCrewItemByCrewAndWeek(crewName, weekMonday) {
  const q = `{
    boards(ids: [${CREW_BOARD}]) {
      items_page(
        limit: 5,
        query_params: {
          rules: [
            { column_id: "${COL_CA_CREW_TEXT}", compare_value: ["${crewName}"], operator: any_of },
            { column_id: "${COL_CA_WEEK}", compare_value: ["EXACT", "${weekMonday}"], operator: any_of }
          ]
        }
      ) {
        items { id name }
      }
    }
  }`;
  const d = await gql(q);
  const items = d.boards[0].items_page.items;
  return items[0] || null;
}

async function deleteExistingSubitemsForJob(masterPmId) {
  let deleted = 0;
  const toDelete = [];
  let cursor = null;

  for (let page = 0; page < 20; page++) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `{
      boards(ids: [${CREW_BOARD}]) {
        items_page(limit: 50${cursorArg}) {
          cursor
          items {
            id
            subitems {
              id
              column_values(ids: ["${COL_SI_RELATED_JOB}"]) {
                id
                value
              }
            }
          }
        }
      }
    }`;
    const d = await gql(q);
    const p = d.boards[0].items_page;
    for (const parent of p.items) {
      for (const sub of (parent.subitems || [])) {
        const relVal = sub.column_values[0]?.value;
        if (!relVal) continue;
        try {
          const parsed = JSON.parse(relVal);
          const linkedIds = (parsed.linkedPulseIds || []).map(x => String(x.linkedPulseId));
          if (linkedIds.includes(String(masterPmId))) toDelete.push(sub.id);
        } catch {}
      }
    }
    cursor = p.cursor;
    if (!cursor) break;
  }

  for (const subId of toDelete) {
    if (DRY_RUN) {
      console.log(`  ○ would delete subitem ${subId}`);
    } else {
      const m = `mutation { delete_item(item_id: ${subId}) { id } }`;
      try { await gql(m); deleted++; } catch (e) {
        console.error(`  ✗ failed to delete subitem ${subId}: ${e.message}`);
      }
      await sleep(RATE_LIMIT_MS);
    }
  }
  return deleted;
}

// Write station windows + finish dates back to Production Load Board
async function writeWindowsToJob(jobId, windows) {
  const updates = {};

  // Week columns need {startDate, endDate} format
  const wk = (start, end) => start && end
    ? { startDate: start, endDate: fridayOf(end) }
    : null;

  if (wk(windows.eng.start, windows.eng.end))
    updates[COL_PL_ENG_WINDOW] = wk(windows.eng.start, windows.eng.end);
  if (wk(windows.panel.start, windows.panel.end))
    updates[COL_PL_PANEL_WINDOW] = wk(windows.panel.start, windows.panel.end);
  if (wk(windows.bench.start, windows.bench.end))
    updates[COL_PL_BENCH_WINDOW] = wk(windows.bench.start, windows.bench.end);
  if (wk(windows.preFin.start, windows.preFin.end))
    updates[COL_PL_PREFIN_WINDOW] = wk(windows.preFin.start, windows.preFin.end);
  if (wk(windows.postFin.start, windows.postFin.end))
    updates[COL_PL_POSTFIN_WINDOW] = wk(windows.postFin.start, windows.postFin.end);
  if (wk(windows.packShip.start, windows.packShip.end))
    updates[COL_PL_PACKSHIP_WINDOW] = wk(windows.packShip.start, windows.packShip.end);

  if (windows.finishDrop)
    updates[COL_PL_FINISH_DROP] = { date: windows.finishDrop };
  if (windows.finishReturn)
    updates[COL_PL_FINISH_RETURN] = { date: windows.finishReturn };

  const colValStr = JSON.stringify(updates).replace(/"/g, '\\"');

  const m = `mutation {
    change_multiple_column_values(
      item_id: ${jobId},
      board_id: ${PROD_LOAD_BOARD},
      column_values: "${colValStr}"
    ) { id }
  }`;
  await gql(m);
}

async function createSubitem(parentId, jobName, station, masterPmId, hours, crewName) {
  const subName = `${jobName} — ${station}`;
  const stationIndex = STATION_ID[station];
  const userId = CREW_USER_ID[crewName];

  const columnValues = {};
  columnValues[COL_SI_STATION] = { ids: [stationIndex] };
  columnValues[COL_SI_RELATED_JOB] = { item_ids: [Number(masterPmId)] };
  columnValues[COL_SI_HOURS] = hours;
  columnValues[COL_SI_ASSIGNED_TEXT] = crewName;
  if (userId) {
    columnValues[COL_SI_OWNER] = { personsAndTeams: [{ id: userId, kind: 'person' }] };
  }

  const colValStr = JSON.stringify(columnValues).replace(/"/g, '\\"');

  const m = `mutation {
    create_subitem(
      parent_item_id: ${parentId},
      item_name: "${subName.replace(/"/g, '\\"')}",
      column_values: "${colValStr}"
    ) { id }
  }`;
  await gql(m);
}

async function updateJobStatus(jobId, newStatus) {
  const m = `mutation {
    change_simple_column_value(
      item_id: ${jobId},
      board_id: ${PROD_LOAD_BOARD},
      column_id: "${COL_PL_STATUS}",
      value: "${newStatus}"
    ) { id }
  }`;
  await gql(m);
}

// =========== MAIN SCHEDULING LOGIC ===========

async function scheduleJob(job) {
  const cols = Object.fromEntries(job.column_values.map(c => [c.id, c]));
  const jobName = job.name;
  const jobId = job.id;
  const subtype = cols[COL_PL_SUBTYPE]?.text;
  // Mirror column returns value via display_value, not text
  const deliveryDate = cols[COL_PL_DELIVERY]?.display_value || cols[COL_PL_DELIVERY]?.text;
  const finishingDays = parseFloat(cols[COL_PL_FINISHING_DAYS]?.text) || DEFAULT_FINISHING_DAYS;

  // Resolve the linked Master PM Board item ID (for subitem Related Job)
  let masterPmId = null;
  const linkedIds = cols[COL_PL_MASTER_PM]?.linked_item_ids || [];
  if (linkedIds.length > 0) masterPmId = String(linkedIds[0]);

  if (!subtype || !ROUTING[subtype]) {
    console.log(`  ⚠ ${jobName}: unknown/missing subtype "${subtype}", skipping`);
    return;
  }
  if (!deliveryDate) {
    console.log(`  ⚠ ${jobName}: missing Delivery Date, skipping`);
    return;
  }
  if (!masterPmId) {
    console.log(`  ⚠ ${jobName}: no Master PM Board link populated — fix the Master PM Link column on the Production Load Board, then re-trigger`);
    return;
  }

  // Formula columns use display_value, not text
  const formulaHrs = col => parseFloat(col?.display_value ?? col?.text) || 0;
  const hours = {
    eng:     formulaHrs(cols[COL_PL_ENG_HRS]),
    panel:   formulaHrs(cols[COL_PL_PANEL_HRS]),
    bench:   formulaHrs(cols[COL_PL_BENCH_HRS]),
    preFin:  formulaHrs(cols[COL_PL_PREFIN_HRS]),
    postFin: formulaHrs(cols[COL_PL_POSTFIN_HRS]),
  };

  console.log(`\n→ ${jobName} (${subtype}) — delivery ${deliveryDate}`);
  console.log(`  Hours: Eng=${hours.eng} Panel=${hours.panel} Bench=${hours.bench} PreFin=${hours.preFin} PostFin=${hours.postFin}`);

  // 1. Calculate windows
  const windows = calculateWindows(deliveryDate, finishingDays, hours);
  console.log(`  Windows:`);
  if (windows.eng.start)      console.log(`    Engineering:           ${windows.eng.start} → ${windows.eng.end} (${windows.eng.weeks.length}wk)`);
  if (windows.panel.start)    console.log(`    Panel Processing:      ${windows.panel.start} → ${windows.panel.end} (${windows.panel.weeks.length}wk)`);
  if (windows.bench.start)    console.log(`    Benchwork:             ${windows.bench.start} → ${windows.bench.end} (${windows.bench.weeks.length}wk)`);
  if (windows.preFin.start)   console.log(`    Pre Fin Cab Assembly:  ${windows.preFin.start} → ${windows.preFin.end} (${windows.preFin.weeks.length}wk)`);
  if (windows.finishDrop)     console.log(`    Finish Drop Date:      ${windows.finishDrop}`);
  if (windows.finishReturn)   console.log(`    Finish Return Date:    ${windows.finishReturn}`);
  if (windows.postFin.start)  console.log(`    Post Fin Cab Assembly: ${windows.postFin.start} → ${windows.postFin.end} (${windows.postFin.weeks.length}wk)`);
  if (windows.packShip.start) console.log(`    Pack & Ship/Delivery:  ${windows.packShip.start} → ${windows.packShip.end}`);

  // 2. Write windows back to Production Load Board
  if (!DRY_RUN) {
    try {
      await writeWindowsToJob(jobId, windows);
      console.log(`  ✓ Windows written to Production Load Board`);
    } catch (e) {
      console.error(`  ✗ FAIL write windows: ${e.message}`);
      return;  // don't create subitems if windows failed
    }
    await sleep(RATE_LIMIT_MS);
  }

  // 3. Delete existing subitems (idempotent re-run)
  if (!DRY_RUN) {
    const deleted = await deleteExistingSubitemsForJob(masterPmId);
    if (deleted > 0) console.log(`  Deleted ${deleted} existing subitems`);
  }

  // 4. Create subitems for each station × week × primary crew
  const stationPlans = [
    { name: 'Engineering',           weeks: windows.eng.weeks,      hrs: hours.eng },
    { name: 'Panel Processing',      weeks: windows.panel.weeks,    hrs: hours.panel },
    { name: 'Benchwork',             weeks: windows.bench.weeks,    hrs: hours.bench },
    { name: 'Pre Fin Cab Assembly',  weeks: windows.preFin.weeks,   hrs: hours.preFin },
    { name: 'Post Fin Cab Assembly', weeks: windows.postFin.weeks,  hrs: hours.postFin },
    { name: 'Pack & Ship',           weeks: windows.packShip.weeks, hrs: 2 },  // fixed 2 hrs
    { name: 'Delivery',              weeks: windows.packShip.weeks, hrs: 2 },  // fixed 2 hrs
  ];

  let createdCount = 0;
  for (const plan of stationPlans) {
    if (plan.weeks.length === 0 || plan.hrs <= 0) continue;

    const hoursPerWeek = plan.hrs / plan.weeks.length;

    for (const weekMonday of plan.weeks) {
      const primariesBase = ROUTING[subtype][plan.name] || [];
      const primaries = filterBob(primariesBase, weekMonday);

      if (primaries.length === 0) {
        console.log(`  ⚠ ${plan.name} @ ${weekMonday}: no primaries available`);
        continue;
      }

      const hoursPerPerson = hoursPerWeek / primaries.length;

      for (const crewName of primaries) {
        const parent = await getCrewItemByCrewAndWeek(crewName, weekMonday);
        if (!parent) {
          console.log(`  ⚠ ${crewName} @ ${weekMonday}: no crew allocation row found`);
          continue;
        }

        if (DRY_RUN) {
          console.log(`  ○ ${jobName} — ${plan.name} → ${crewName} @ ${weekMonday} (${hoursPerPerson.toFixed(1)} hrs)`);
        } else {
          try {
            await createSubitem(parent.id, jobName, plan.name, masterPmId, Number(hoursPerPerson.toFixed(2)), crewName);
            console.log(`  ✓ ${jobName} — ${plan.name} → ${crewName} @ ${weekMonday} (${hoursPerPerson.toFixed(1)} hrs)`);
            createdCount++;
          } catch (e) {
            console.error(`  ✗ FAIL create subitem: ${e.message}`);
          }
          await sleep(RATE_LIMIT_MS);
        }
      }
    }
  }

  console.log(`  Summary: ${createdCount} subitems created`);

  // 5. Flip job status to Scheduled
  if (!DRY_RUN && createdCount > 0) {
    try {
      await updateJobStatus(jobId, 'Scheduled');
      console.log(`  ✓ Status → Scheduled`);
    } catch (e) {
      console.error(`  ✗ FAIL status update: ${e.message}`);
    }
  }
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Bob start date: ${BOB_START_DATE}`);
  console.log('Fetching Ready to Schedule jobs...');

  const jobs = await getReadyToScheduleJobs();
  console.log(`Got ${jobs.length} jobs ready to schedule.`);

  if (jobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const job of jobs) {
    try {
      await scheduleJob(job);
    } catch (e) {
      console.error(`✗ FAIL ${job.name}: ${e.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
