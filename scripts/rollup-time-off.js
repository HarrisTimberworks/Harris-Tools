#!/usr/bin/env node
/*
 * Time Off Rollup (Daily)
 *
 * Reads approved Time Off board entries and writes Time Off Hours
 * on each Weekly Crew Allocation parent item.
 *
 * Logic:
 *   - For each approved Time Off entry, distribute hours across affected weeks
 *   - Full-day types (Vacation/Sick/Personal/Holiday) = 8 hrs/weekday
 *   - Partial Day = use Hours Off value (single-day)
 *   - Match allocation items by Crew Member (Text) column, which is
 *     derived from the monday.com display name via PERSON_TO_NAME
 *   - Zero out allocation items that previously had hours but no
 *     longer have a matching approved entry
 *
 * Usage:
 *   set MONDAY_API_TOKEN=your_token
 *   node scripts/rollup-time-off.js
 */

const CREW_BOARD = 18409529791;
const TIME_OFF_BOARD = 18409530322;

const COL_WEEK = 'date_mm2kjth4';
const COL_CREW_TEXT = 'text_mm2mhm0y';
const COL_TIME_OFF_HOURS = 'numeric_mm2k57x0';

const COL_TO_PERSON = 'multiple_person_mm2kkp12';
const COL_TO_DATES = 'timerange_mm2k10v8';
const COL_TO_HOURS = 'numeric_mm2kkfcj';
const COL_TO_TYPE = 'color_mm2kfmtt';
const COL_TO_STATUS = 'color_mm2kt4fv';

// monday.com display name -> crew display name
const PERSON_TO_NAME = {
  'Chris Harris': 'Chris',
  'Jonathan Korban': 'Jonathan',
  'paisios@harristimberworks.com': 'Paisios',
  'rob tomb': 'Rob',
  'ian ratcliffe': 'Ian',
  'Vladimir Almgren': 'Spencer',
  'Robert Brening': 'Bob',
};

const API_URL = 'https://api.monday.com/v2';
const RATE_LIMIT_MS = 150;
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

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function weekdaysBetween(start, end) {
  const result = [];
  const startDate = new Date(start + 'T12:00:00Z');
  const endDate = new Date(end + 'T12:00:00Z');
  for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

function resolveCrewName(personText) {
  if (!personText) return null;
  // personText can be comma-separated if multiple people
  const first = personText.split(',')[0].trim();
  return PERSON_TO_NAME[first] || first;
}

async function getTimeOffEntries() {
  const q = `{
    boards(ids: [${TIME_OFF_BOARD}]) {
      items_page(limit: 200) {
        items {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    }
  }`;
  const d = await gql(q);
  return d.boards[0].items_page.items;
}

async function getCrewItems() {
  const items = [];
  let cursor = null;
  for (let page = 1; page < 20; page++) {
    const cursorArg = cursor ? `cursor: "${cursor}"` : '';
    const q = `{
      boards(ids: [${CREW_BOARD}]) {
        items_page(limit: 100, ${cursorArg}) {
          cursor
          items {
            id
            name
            column_values(ids: ["${COL_WEEK}","${COL_CREW_TEXT}","${COL_TIME_OFF_HOURS}"]) {
              id
              text
            }
          }
        }
      }
    }`;
    const d = await gql(q);
    const p = d.boards[0].items_page;
    items.push(...p.items);
    cursor = p.cursor;
    if (!cursor) break;
  }
  return items;
}

function buildWeekMap(timeOffEntries) {
  const map = new Map();
  for (const entry of timeOffEntries) {
    const cols = Object.fromEntries(entry.column_values.map(c => [c.id, c]));
    const status = cols[COL_TO_STATUS]?.text;
    if (status !== 'Approved') continue;

    const personText = cols[COL_TO_PERSON]?.text;
    const datesValue = cols[COL_TO_DATES]?.value;
    const type = cols[COL_TO_TYPE]?.text;
    const hoursRaw = cols[COL_TO_HOURS]?.text;

    if (!personText || !datesValue) continue;

    let dateVal;
    try { dateVal = JSON.parse(datesValue); } catch { continue; }
    const from = dateVal.from;
    const to = dateVal.to || from;
    if (!from) continue;

    const crewName = resolveCrewName(personText);
    if (!crewName) continue;

    const days = weekdaysBetween(from, to);
    if (days.length === 0) continue;

    let hoursPerDay;
    if (type === 'Partial Day') {
      // partial day: treat the whole Hours Off as applying to the first day
      const h = parseFloat(hoursRaw) || 4;
      const monday = mondayOf(days[0]);
      const key = `${crewName}:${monday}`;
      map.set(key, (map.get(key) || 0) + h);
      continue;
    } else {
      hoursPerDay = 8;
    }

    for (const day of days) {
      const monday = mondayOf(day);
      const key = `${crewName}:${monday}`;
      map.set(key, (map.get(key) || 0) + hoursPerDay);
    }
  }
  return map;
}

async function updateTimeOffHours(itemId, hours) {
  const q = `mutation {
    change_simple_column_value(
      item_id: ${itemId},
      board_id: ${CREW_BOARD},
      column_id: "${COL_TIME_OFF_HOURS}",
      value: "${hours}"
    ) { id }
  }`;
  await gql(q);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('Fetching time off entries...');
  const entries = await getTimeOffEntries();
  console.log(`Got ${entries.length} time off entries.`);

  const weekMap = buildWeekMap(entries);
  console.log(`Mapped ${weekMap.size} (crew, week) tuples with time off.`);

  console.log('Fetching crew allocation items...');
  const crewItems = await getCrewItems();
  console.log(`Got ${crewItems.length} crew items.\n`);

  let updated = 0, cleared = 0, unchanged = 0, failed = 0;
  for (const item of crewItems) {
    const cols = Object.fromEntries(item.column_values.map(c => [c.id, c]));
    const crewText = cols[COL_CREW_TEXT]?.text || '';
    const weekText = cols[COL_WEEK]?.text || '';
    const currentHours = parseFloat(cols[COL_TIME_OFF_HOURS]?.text) || 0;

    if (!crewText || !weekText) continue;

    const key = `${crewText}:${weekText}`;
    const newHours = weekMap.get(key) || 0;

    if (newHours === currentHours) { unchanged++; continue; }

    if (DRY_RUN) {
      console.log(`  ○ ${item.name}   ${currentHours} -> ${newHours}`);
    } else {
      try {
        await updateTimeOffHours(item.id, newHours);
        console.log(`  ✓ ${item.name}   ${currentHours} -> ${newHours}`);
      } catch (e) {
        console.error(`  ✗ FAIL ${item.name}: ${e.message}`);
        failed++;
        continue;
      }
      await sleep(RATE_LIMIT_MS);
    }

    if (newHours > 0) updated++;
    else cleared++;
  }

  console.log(`\n====== SUMMARY ======`);
  console.log(`Set time off hours: ${updated}`);
  console.log(`Cleared stale entries: ${cleared}`);
  console.log(`Unchanged: ${unchanged}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
