#!/usr/bin/env node
/**
 * A4 test — crew parent row validation at plan() start.
 *
 * Asserts:
 *   1. findMissingCrewParents flags every (crew × week) gap in the planning
 *      horizon EXCEPT subcontractor virtual-crew (no parent rows by design)
 *      and Bob's pre-BOB_START_DATE weeks (Bob is subcontract-only before then).
 *   2. autoCreateCrewParents emits exactly one create_item mutation per missing
 *      entry, against BOARD_CREW_ALLOC.
 *
 * Runs without MONDAY_API_TOKEN — uses an injected gql stub.
 */

const {
  findMissingCrewParents,
  autoCreateCrewParents,
  BOARD_CREW_ALLOC,
} = require('./rebalance-schedule.js');

const CREWS = ['Chris', 'Jonathan', 'Paisios', 'Rob', 'Ian', 'Spencer', 'Ken', 'Bob'];
const WEEKS = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01'];
const BOB_START = '2026-05-18';

function buildCompleteParents() {
  const parents = [];
  let id = 1000;
  for (const crew of CREWS) {
    for (const week of WEEKS) {
      // Bob has no parent rows before BOB_START_DATE — by design
      if (crew === 'Bob' && week < BOB_START) continue;
      parents.push({ parentId: String(id++), crew, week, base: 40, timeOff: 0, nonProd: 0 });
    }
  }
  return parents;
}

const failures = [];
let checks = 0;
function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

(async () => {

  console.log('Test 1: missing Bob 5/25 surfaces in the missing list');
  {
    const parents = buildCompleteParents().filter(
      p => !(p.crew === 'Bob' && p.week === '2026-05-25')
    );
    const missing = findMissingCrewParents({
      crewParents: parents,
      weeks: WEEKS,
      crews: CREWS,
      subcontractorNames: new Set(['CU-Bench-sub-A', 'BCH-Bench-sub']),
      crewStartDates: { Bob: BOB_START },
    });
    check('exactly one missing entry', missing.length === 1, `got ${missing.length}: ${JSON.stringify(missing)}`);
    check(
      'missing entry is Bob 2026-05-25',
      missing[0]?.crew === 'Bob' && missing[0]?.week === '2026-05-25',
      JSON.stringify(missing[0])
    );
  }

  console.log('\nTest 2: Bob pre-BOB_START_DATE gaps are NOT flagged');
  {
    // Drop ALL Bob entries — only weeks >= BOB_START should appear in missing
    const parents = buildCompleteParents().filter(p => p.crew !== 'Bob');
    const missing = findMissingCrewParents({
      crewParents: parents,
      weeks: WEEKS,
      crews: CREWS,
      subcontractorNames: new Set(),
      crewStartDates: { Bob: BOB_START },
    });
    const bobMissing = missing.filter(m => m.crew === 'Bob');
    check(
      'Bob missing list matches weeks >= BOB_START_DATE only (5/18, 5/25, 6/01)',
      bobMissing.length === 3 && bobMissing.every(m => m.week >= BOB_START),
      `got ${JSON.stringify(bobMissing)}`
    );
    check(
      'Bob 5/04 not in missing list',
      !bobMissing.some(m => m.week === '2026-05-04'),
      JSON.stringify(bobMissing)
    );
    check(
      'Bob 5/11 not in missing list',
      !bobMissing.some(m => m.week === '2026-05-11'),
      JSON.stringify(bobMissing)
    );
  }

  console.log('\nTest 3: subcontractor virtual-crew never appears in missing list');
  {
    const parents = buildCompleteParents();
    // Pretend the validator is asked about a subcontractor crew with NO parent rows
    const crewsWithSub = [...CREWS, 'CU-Bench-sub-A'];
    const missing = findMissingCrewParents({
      crewParents: parents,
      weeks: WEEKS,
      crews: crewsWithSub,
      subcontractorNames: new Set(['CU-Bench-sub-A']),
      crewStartDates: { Bob: BOB_START },
    });
    check(
      'CU-Bench-sub-A not in missing list despite having zero parent rows',
      !missing.some(m => m.crew === 'CU-Bench-sub-A'),
      JSON.stringify(missing)
    );
    check(
      'no other gaps reported (full roster present)',
      missing.length === 0,
      JSON.stringify(missing)
    );
  }

  console.log('\nTest 4: --auto-create-parents emits exactly 1 mutation per missing row');
  {
    const missing = [{ crew: 'Bob', week: '2026-05-25' }];
    const gqlCalls = [];
    const gqlStub = async (query, variables) => {
      gqlCalls.push({ query, variables });
      return { create_item: { id: '99999001' } };
    };
    const created = await autoCreateCrewParents(missing, gqlStub);

    check('exactly 1 gql call for 1 missing entry', gqlCalls.length === 1, `got ${gqlCalls.length}`);
    check(
      'mutation is create_item',
      /create_item\s*\(/.test(gqlCalls[0]?.query || ''),
      gqlCalls[0]?.query?.slice(0, 80)
    );
    check(
      'mutation targets BOARD_CREW_ALLOC',
      gqlCalls[0]?.variables?.boardId === String(BOARD_CREW_ALLOC),
      `boardId=${gqlCalls[0]?.variables?.boardId}, expected=${BOARD_CREW_ALLOC}`
    );
    check(
      'item name encodes crew and week (Bob, 05/25)',
      /Bob/.test(gqlCalls[0]?.variables?.itemName || '') &&
        /05.25/.test(gqlCalls[0]?.variables?.itemName || ''),
      gqlCalls[0]?.variables?.itemName
    );
    check(
      'columnValues includes the week date',
      /2026-05-25/.test(gqlCalls[0]?.variables?.columnValues || ''),
      gqlCalls[0]?.variables?.columnValues
    );
    check(
      'autoCreate returns one created entry with the gql-returned id',
      created.length === 1 && created[0]?.id === '99999001' && created[0]?.crew === 'Bob' && created[0]?.week === '2026-05-25',
      JSON.stringify(created)
    );
  }

  console.log('\nTest 5: autoCreateCrewParents fires N mutations for N missing rows');
  {
    const missing = [
      { crew: 'Ian', week: '2026-05-25' },
      { crew: 'Bob', week: '2026-06-01' },
      { crew: 'Paisios', week: '2026-05-25' },
    ];
    const gqlCalls = [];
    let nextId = 100;
    const gqlStub = async (query, variables) => {
      gqlCalls.push({ query, variables });
      return { create_item: { id: String(nextId++) } };
    };
    const created = await autoCreateCrewParents(missing, gqlStub);
    check('3 missing entries → 3 gql calls', gqlCalls.length === 3, `got ${gqlCalls.length}`);
    check('returned 3 created records', created.length === 3, JSON.stringify(created));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All A4 tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
