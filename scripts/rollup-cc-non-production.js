#!/usr/bin/env node
/*
 * Command Center Non-Production Rollup (Daily)
 *
 * Reads both Command Centers (Chris and Jonathan). For each item with
 * Activity Type = "Non-Production", sums the Hours column. Groups by
 * (crew, week-Monday) based on the Scheduled Day date column.
 *
 * Writes the total to Weekly Crew Allocation Board's Non-Production
 * Hours column. Zeroes out stale entries.
 *
 * Crew attribution:
 *   - Chris's CC  -> Chris
 *   - Jonathan's CC -> Jonathan
 *
 * (If Bob gets a CC when he starts 5/18, extend CC_CONFIG.)
 *
 * Usage:
 *   set MONDAY_API_TOKEN=your_token
 *   node scripts/rollup-cc-non-production.js
 */

const CREW_BOARD = 18409529791;

// CC board configuration: board_id + owner crew name
const CC_CONFIG = [
  { board: 18407211932, crew: 'Chris' },
  { board: 18409239682, crew: 'Jonathan' },
];

const COL_CC_HOURS = 'numeric_mm2gr3mc';
const COL_CC_ACTIVITY = 'color_mm2gxkcy';
const COL_CC_DATE = 'date_mm233znr';

const COL_ALLOC_WEEK = 'date_mm2kjth4';
const COL_ALLOC_CREW_TEXT = 'text_mm2mhm0y';
const COL_ALLOC_NONPROD = 'numeric_mm2knj6j';

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

async function getCCItems(boardId) {
  const items = [];
  let cursor = null;
  for (let page = 1; page < 20; page++) {
    const cursorArg = cursor ? `cursor: "${cursor}"` : '';
    const q = `{
      boards(ids: [${boardId}]) {
        items_page(limit: 100, ${cursorArg}) {
          cursor
          items {
            id
            name
            column_values(ids: ["${COL_CC_HOURS}","${COL_CC_ACTIVITY}","${COL_CC_DATE}"]) {
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
            column_values(ids: ["${COL_ALLOC_WEEK}","${COL_ALLOC_CREW_TEXT}","${COL_ALLOC_NONPROD}"]) {
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

function buildNonProdMap(ccItemsByCrew) {
  const map = new Map();
  let countedItems = 0, skippedNoDate = 0, skippedNoHours = 0,
      skippedNotNonProd = 0;

  for (const { crew, items } of ccItemsByCrew) {
    for (const item of items) {
      const cols = Object.fromEntries(item.column_values.map(c => [c.id, c]));
      const activity = cols[COL_CC_ACTIVITY]?.text;
      const dateText = cols[COL_CC_DATE]?.text;
      const hoursText = cols[COL_CC_HOURS]?.text;

      if (activity !== 'Non-Production') { skippedNotNonProd++; continue; }
      if (!dateText) { skippedNoDate++; continue; }
      const hours = parseFloat(hoursText);
      if (!hours || hours <= 0) { skippedNoHours++; continue; }

      const monday = mondayOf(dateText);
      const key = `${crew}:${monday}`;
      map.set(key, (map.get(key) || 0) + hours);
      countedItems++;
    }
  }

  console.log(`  Counted: ${countedItems} non-prod items`);
  console.log(`  Skipped: ${skippedNotNonProd} not non-prod, ${skippedNoDate} no date, ${skippedNoHours} no hours`);
  return map;
}

async function updateNonProdHours(itemId, hours) {
  const q = `mutation {
    change_simple_column_value(
      item_id: ${itemId},
      board_id: ${CREW_BOARD},
      column_id: "${COL_ALLOC_NONPROD}",
      value: "${hours}"
    ) { id }
  }`;
  await gql(q);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('Fetching Command Center items...');

  const ccItemsByCrew = [];
  for (const { board, crew } of CC_CONFIG) {
    const items = await getCCItems(board);
    console.log(`  ${crew} CC: ${items.length} items`);
    ccItemsByCrew.push({ crew, items });
  }

  console.log('\nBuilding non-production map...');
  const npMap = buildNonProdMap(ccItemsByCrew);
  console.log(`Mapped ${npMap.size} (crew, week) tuples.\n`);

  console.log('Fetching crew allocation items...');
  const crewItems = await getCrewItems();
  console.log(`Got ${crewItems.length} crew items.\n`);

  let updated = 0, cleared = 0, unchanged = 0, failed = 0;
  for (const item of crewItems) {
    const cols = Object.fromEntries(item.column_values.map(c => [c.id, c]));
    const crewText = cols[COL_ALLOC_CREW_TEXT]?.text || '';
    const weekText = cols[COL_ALLOC_WEEK]?.text || '';
    const currentHours = parseFloat(cols[COL_ALLOC_NONPROD]?.text) || 0;

    if (!crewText || !weekText) continue;

    const key = `${crewText}:${weekText}`;
    const newHours = npMap.get(key) || 0;

    if (newHours === currentHours) { unchanged++; continue; }

    if (DRY_RUN) {
      console.log(`  ○ ${item.name}   ${currentHours} -> ${newHours}`);
    } else {
      try {
        await updateNonProdHours(item.id, newHours);
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
  console.log(`Set non-prod hours: ${updated}`);
  console.log(`Cleared stale entries: ${cleared}`);
  console.log(`Unchanged: ${unchanged}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
