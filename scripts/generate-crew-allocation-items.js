#!/usr/bin/env node
/*
 * Generate Weekly Crew Allocation Board items in monday.com.
 *
 * Creates one parent item per crew member per week for the date range
 * configured below. Intended for yearly rollovers: update START_DATE and
 * END_DATE to the new range, then run once.
 *
 * WARNING: this script is NOT idempotent. It performs no existence check
 * before creating items. Do not re-run over an overlapping date range —
 * it will create duplicate rows on the board.
 *
 * Supports DRY_RUN=1 to preview without writing.
 *
 * Usage (Windows Command Prompt):
 *   set MONDAY_API_TOKEN=your_token_here
 *   node scripts/generate-crew-allocation-items.js
 *
 * Dry run:
 *   set DRY_RUN=1
 *   node scripts/generate-crew-allocation-items.js
 */

// ---------- CONFIG ----------

const BOARD_ID = 18409529791;

// Date range (Mondays only). Both inclusive. Update to re-run for new ranges.
const START_DATE = '2026-04-20';
const END_DATE   = '2026-12-28';

// Column IDs on the Weekly Crew Allocation Board.
const COL_DATE    = 'date_mm2kjth4';           // Week-of date (Monday)
const COL_HOURS   = 'numeric_mm2kbvse';        // Base hours for the week
const COL_PERSON  = 'multiple_person_mm2kr7ky'; // People column

// Crew roster. `userId: null` means placeholder (no monday user assigned).
const CREW = [
  { displayName: 'Chris',    userId: 77398023,  baseHours: 15 },
  { displayName: 'Jonathan', userId: 78941017,  baseHours: 40 },
  { displayName: 'Paisios',  userId: 77398083,  baseHours: 40 },
  { displayName: 'Rob',      userId: 102500064, baseHours: 0  },
  { displayName: 'Ian',      userId: 99508397,  baseHours: 40 },
  // "Spencer" is the display name; the monday user is Vladimir Almgren.
  { displayName: 'Spencer',  userId: 97341714,  baseHours: 40 },
  { displayName: 'Ken',      userId: null,      baseHours: 40 },
  // Bob only starts on the 5/18/2026 week.
  { displayName: 'Bob',      userId: 100329892, baseHours: 40, startDate: '2026-05-18' },
];

const API_URL = 'https://api.monday.com/v2';
const RATE_LIMIT_MS = 200;

// ---------- HELPERS ----------

const DRY_RUN = process.env.DRY_RUN === '1';
const TOKEN   = process.env.MONDAY_API_TOKEN;

if (!DRY_RUN && !TOKEN) {
  console.error('ERROR: MONDAY_API_TOKEN environment variable is not set.');
  console.error('Set it in Command Prompt:  set MONDAY_API_TOKEN=your_token_here');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse YYYY-MM-DD as a local date (avoids UTC off-by-one).
function parseLocalDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMmDd(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}/${d}`;
}

// Build the list of Mondays in [START_DATE, END_DATE].
function buildWeekList() {
  const start = parseLocalDate(START_DATE);
  const end   = parseLocalDate(END_DATE);
  if (start.getDay() !== 1) {
    throw new Error(`START_DATE ${START_DATE} is not a Monday.`);
  }
  const weeks = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
    weeks.push(new Date(d));
  }
  return weeks;
}

// ---------- MONDAY API ----------

async function createItem(itemName, columnValues) {
  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) { id }
    }
  `;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        boardId: String(BOARD_ID),
        itemName,
        // monday expects column_values as a JSON string, even though the
        // variable type is JSON. Stringify once here.
        columnValues: JSON.stringify(columnValues),
      },
    }),
  });

  const json = await response.json();
  if (json.errors || json.error_message) {
    throw new Error(`monday API error: ${JSON.stringify(json.errors || json.error_message)}`);
  }
  return json.data.create_item.id;
}

// ---------- MAIN ----------

async function main() {
  const weeks = buildWeekList();

  console.log('Weekly Crew Allocation — item generator');
  console.log('---------------------------------------');
  console.log(`Board:      ${BOARD_ID}`);
  console.log(`Range:      ${START_DATE} → ${END_DATE}  (${weeks.length} weeks)`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN (no API calls)' : 'LIVE'}`);
  console.log('');

  let createdCount = 0;
  const perPerson  = {};
  for (const p of CREW) perPerson[p.displayName] = { created: 0 };

  for (const weekDate of weeks) {
    const weekYmd  = formatYmd(weekDate);
    const weekMmDd = formatMmDd(weekDate);

    for (const person of CREW) {
      // Bob (or any person with a startDate) only gets items on/after that week.
      if (person.startDate && weekYmd < person.startDate) {
        continue;
      }

      const itemName = `${person.displayName} — Week of ${weekMmDd}`;

      const columnValues = {
        [COL_DATE]:  { date: weekYmd },
        [COL_HOURS]: person.baseHours,
      };
      if (person.userId) {
        columnValues[COL_PERSON] = { personsAndTeams: [{ id: person.userId, kind: 'person' }] };
      }

      if (DRY_RUN) {
        console.log(`  ○  WOULD  ${itemName}   hours=${person.baseHours}  user=${person.userId ?? '(none)'}`);
      } else {
        try {
          const id = await createItem(itemName, columnValues);
          console.log(`  ✓  CREATE ${itemName}   id=${id}`);
        } catch (err) {
          console.error(`  ✗  FAIL   ${itemName}   ${err.message}`);
          throw err;
        }
        await sleep(RATE_LIMIT_MS);
      }

      createdCount++;
      perPerson[person.displayName].created++;
    }
  }

  console.log('');
  console.log('---------------------------------------');
  console.log(`Summary (${DRY_RUN ? 'dry run' : 'live'}):`);
  console.log(`  ${DRY_RUN ? 'Would create' : 'Created'}: ${createdCount}`);
  console.log('  By person:');
  for (const name of Object.keys(perPerson)) {
    const { created } = perPerson[name];
    console.log(`    ${name.padEnd(9)}  ${DRY_RUN ? 'would-create' : 'created'}=${created}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
