#!/usr/bin/env node
/*
 * Cross-Training Validator (Daily)
 *
 * Reads all subitems on the Weekly Crew Allocation Board. For each
 * subitem, checks the (Person, Station) pair against the HTW cross-
 * training matrix. Sets the Cross-Train Flag column accordingly:
 *
 *   Primary      (label id 1)  -> trained and primary for this station
 *   Secondary    (label id 0)  -> cross-trained, can do if needed
 *   Not Trained  (label id 2)  -> red flag, person shouldn't be here
 *
 * Usage:
 *   set MONDAY_API_TOKEN=your_token
 *   node scripts/validate-cross-training.js
 */

const CREW_BOARD = 18409529791;
const SUBITEM_BOARD = 18409530171;

const COL_STATION = 'dropdown_mm2kex19';
const COL_OWNER = 'person';
const COL_ASSIGNED_TEXT = 'text_mm2mpjcn';
const COL_CROSS_TRAIN = 'color_mm2m34ta';

// Cross-training matrix: crew name -> { station: 'Primary' | 'Secondary' }
// Stations not listed for a person = "Not Trained"
const MATRIX = {
  Chris:    { Engineering: 'Primary' },
  Jonathan: {
    Engineering:           'Primary',
    'Pre Fin Cab Assembly': 'Secondary',
    'Post Fin Cab Assembly':'Secondary',
    Delivery:              'Secondary',
  },
  Paisios: {
    Engineering:            'Primary',
    Benchwork:              'Secondary',
    'Pre Fin Cab Assembly': 'Secondary',
    'Post Fin Cab Assembly':'Primary',
    'Pack & Ship':          'Primary',
    Delivery:               'Primary',
  },
  Rob: {
    Engineering: 'Secondary',   // remote part-time
  },
  Ian: {
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Primary',
    'Post Fin Cab Assembly':'Primary',
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  Spencer: {
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Primary',
    'Post Fin Cab Assembly':'Secondary',
  },
  Ken: {
    'Panel Processing':     'Primary',
    'Pre Fin Cab Assembly': 'Secondary',
    'Post Fin Cab Assembly':'Secondary',  // commercial only (script can't detect this nuance)
    'Pack & Ship':          'Secondary',
    Delivery:               'Secondary',
  },
  Bob: {
    'Panel Processing':     'Secondary',
    Benchwork:              'Primary',
    'Pre Fin Cab Assembly': 'Primary',
    'Post Fin Cab Assembly':'Primary',
    'Pack & Ship':          'Secondary',
  },
};

// Cross-Train Flag label IDs (from the Subitem board):
//   0 = Secondary, 1 = Primary, 2 = Not Trained, 3 = Override OK
const FLAG_INDEX = {
  'Primary':     1,
  'Secondary':   0,
  'Not Trained': 2,
};

// monday.com display name -> crew name
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

function resolveCrewName(personText, assignedText) {
  if (assignedText && assignedText.trim()) return assignedText.trim();
  if (!personText) return null;
  const first = personText.split(',')[0].trim();
  return PERSON_TO_NAME[first] || first;
}

function getExpectedFlag(crew, station) {
  const crewMatrix = MATRIX[crew];
  if (!crewMatrix) return null; // unknown person — caller decides
  const level = crewMatrix[station];
  if (level) return level;          // 'Primary' or 'Secondary'
  return 'Not Trained';              // crew exists but not trained here
}

async function getAllSubitems() {
  // Subitems are retrieved via their parent board's items_page with
  // includeSubItems. We'll walk the parent board.
  const subitems = [];
  let cursor = null;
  for (let page = 1; page < 20; page++) {
    const cursorArg = cursor ? `cursor: "${cursor}"` : '';
    const q = `{
      boards(ids: [${CREW_BOARD}]) {
        items_page(limit: 50, ${cursorArg}) {
          cursor
          items {
            id
            subitems {
              id
              name
              column_values(ids: ["${COL_STATION}","${COL_OWNER}","${COL_ASSIGNED_TEXT}","${COL_CROSS_TRAIN}"]) {
                id
                text
              }
            }
          }
        }
      }
    }`;
    const d = await gql(q);
    const p = d.boards[0].items_page;
    for (const parent of p.items) {
      for (const sub of (parent.subitems || [])) subitems.push(sub);
    }
    cursor = p.cursor;
    if (!cursor) break;
  }
  return subitems;
}

async function updateFlag(subitemId, flagLabel) {
  const index = FLAG_INDEX[flagLabel];
  if (index === undefined) throw new Error(`Unknown flag: ${flagLabel}`);
  const q = `mutation {
    change_simple_column_value(
      item_id: ${subitemId},
      board_id: ${SUBITEM_BOARD},
      column_id: "${COL_CROSS_TRAIN}",
      value: "${flagLabel}"
    ) { id }
  }`;
  await gql(q);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('Fetching all subitems...');
  const subitems = await getAllSubitems();
  console.log(`Got ${subitems.length} subitems.\n`);

  let updated = 0, unchanged = 0, skipped = 0, failed = 0;
  const warnings = [];

  for (const sub of subitems) {
    const cols = Object.fromEntries(sub.column_values.map(c => [c.id, c]));
    const station = cols[COL_STATION]?.text || '';
    const ownerText = cols[COL_OWNER]?.text || '';
    const assignedText = cols[COL_ASSIGNED_TEXT]?.text || '';
    const currentFlag = cols[COL_CROSS_TRAIN]?.text || '';

    if (!station) { skipped++; continue; }

    const crew = resolveCrewName(ownerText, assignedText);
    if (!crew) {
      warnings.push(`${sub.id} "${sub.name}": no crew assigned`);
      skipped++;
      continue;
    }

    const expected = getExpectedFlag(crew, station);
    if (!expected) {
      warnings.push(`${sub.id} "${sub.name}": unknown crew "${crew}"`);
      skipped++;
      continue;
    }

    if (currentFlag === expected) { unchanged++; continue; }

    if (DRY_RUN) {
      console.log(`  ○ ${sub.name}   ${crew}/${station}   ${currentFlag || '(empty)'} -> ${expected}`);
      updated++;
    } else {
      try {
        await updateFlag(sub.id, expected);
        console.log(`  ✓ ${sub.name}   ${crew}/${station}   -> ${expected}`);
        updated++;
      } catch (e) {
        console.error(`  ✗ FAIL ${sub.name}: ${e.message}`);
        failed++;
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log(`\n====== SUMMARY ======`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Skipped: ${skipped}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.slice(0, 20).forEach(w => console.log(`  ⚠ ${w}`));
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
