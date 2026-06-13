#!/usr/bin/env node
/**
 * AUDIT FIX (2026-06-11) — config lint tests.
 * Every "error" case here is a shape that previously silently no-op'd.
 */

const { validateOverridesConfig, isMonday } = require('./validate-config.js');

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const CTX = {
  jobIds: ['11111', '22222'],
  crews: ['Bob', 'Spencer', 'Ian', 'BCH-Bench-sub'],
  todayISO: '2026-06-08',
};

(async () => {

  console.log('Test 1: isMonday');
  {
    check('2026-06-08 is Monday', isMonday('2026-06-08') === true, '');
    check('2026-06-11 is not', isMonday('2026-06-11') === false, '');
    check('garbage is not', isMonday('nope') === false && isMonday(null) === false, '');
  }

  console.log('\nTest 2: clean config → no errors');
  {
    const r = validateOverridesConfig({
      forceAssignments: [{ crew: 'Spencer', jobId: '11111', stations: ['Benchwork'], week: '2026-06-15', hours: 8 }],
      jobOverrides: { '22222': { name: 'J', remainingHours: {}, customWindow: { panel: { start: '2026-06-15', end: '2026-06-19' } } } },
      skipJobs: ['11111'],
      crewCapacityOverrides: { '2026-06-15': { Bob: { available: 32 } } },
    }, CTX);
    check('no errors', r.errors.length === 0, JSON.stringify(r.errors));
    check('no warnings', r.warnings.length === 0, JSON.stringify(r.warnings));
  }

  console.log('\nTest 3: the singular-station bug (bit us live 2026-06-11) → error');
  {
    const r = validateOverridesConfig({
      forceAssignments: [{ crew: 'Spencer', jobId: '11111', station: 'Benchwork', week: '2026-06-15', hours: 8 }],
    }, CTX);
    check('flags singular station key', r.errors.some(e => /'station' key/.test(e)), JSON.stringify(r.errors));
  }

  console.log('\nTest 4: silent no-op shapes → errors');
  {
    const r = validateOverridesConfig({
      forceAssignments: [
        { crew: 'Spencer', jobId: '99999', stations: ['Benchwork'], week: '2026-06-15' },   // unknown job
        { crew: 'Nobody', jobId: '11111', stations: ['Benchwork'], week: '2026-06-15' },    // unknown crew
        { crew: 'Bob', jobId: '11111', stations: ['Benchwork'], week: '2026-06-17' },       // Wednesday
        { crew: 'Bob', jobId: '11111', stations: [], week: '2026-06-15' },                  // empty stations
      ],
      jobOverrides: { '11111': { customWindow: { bench: { start: '2026-06-17', end: '2026-06-19' } } } },
      crewCapacityOverrides: { '2026-06-17': { Bob: {} }, '2026-06-15': { Ghost: {} } },
    }, CTX);
    check('unknown jobId flagged', r.errors.some(e => /jobId not found/.test(e)), JSON.stringify(r.errors));
    check('unknown crew flagged', r.errors.some(e => /unknown crew 'Nobody'/.test(e)), '');
    check('non-Monday force week flagged', r.errors.some(e => /not a Monday/.test(e) && /2026-06-17/.test(e)), '');
    check('empty stations flagged', r.errors.some(e => /missing\/empty 'stations'/.test(e)), '');
    check('non-Monday customWindow start flagged', r.errors.some(e => /customWindow\.bench/.test(e)), '');
    check('non-Monday capacity week flagged', r.errors.some(e => /crewCapacityOverrides\['2026-06-17'\]/.test(e)), '');
    check('unknown capacity crew flagged', r.errors.some(e => /Ghost/.test(e)), '');
  }

  console.log('\nTest 5: warnings — past weeks, stale ids');
  {
    const r = validateOverridesConfig({
      forceAssignments: [{ crew: 'Ian', jobId: '11111', stations: ['Panel Processing'], week: '2026-04-20' }],
      jobOverrides: { '99999': { name: 'Gone' } },
      skipJobs: ['88888'],
    }, CTX);
    check('past-week force is a warning, not error', r.warnings.some(w => /in the past/.test(w)) && !r.errors.some(e => /2026-04-20/.test(e)), JSON.stringify({ e: r.errors, w: r.warnings }));
    check('stale jobOverride warned', r.warnings.some(w => /jobOverrides\['99999'\]/.test(w)), '');
    check('stale skipJobs warned', r.warnings.some(w => /skipJobs '88888'/.test(w)), '');
  }

  console.log('\nTest 6: empty context disables id/crew checks (lint degrades gracefully)');
  {
    const r = validateOverridesConfig({
      forceAssignments: [{ crew: 'Whoever', jobId: '424242', stations: ['Benchwork'], week: '2026-06-15' }],
    }, {});
    check('no id/crew errors without context', r.errors.length === 0, JSON.stringify(r.errors));
  }

  // Task 11 (2026-06-12) — stale customWindow detection

  console.log('\nTest 7: customWindow entirely before effectiveWeek → warning');
  {
    // window.end 2026-05-22 < effectiveWeek 2026-06-15 → stale
    const r = validateOverridesConfig({
      jobOverrides: {
        'X': {
          name: 'Old Job',
          customWindow: {
            bench: { start: '2026-05-18', end: '2026-05-22' },
          },
        },
      },
    }, { ...CTX, effectiveWeek: '2026-06-15' });
    check('stale customWindow fires a warning',
      r.warnings.some(w => /jobOverrides\[X\]\.customWindow\.bench is entirely in the past/.test(w)),
      JSON.stringify(r.warnings));
    check('warning text includes end date',
      r.warnings.some(w => /ended 2026-05-22/.test(w)),
      JSON.stringify(r.warnings));
    check('warning text includes effectiveWeek',
      r.warnings.some(w => /effective week 2026-06-15/.test(w)),
      JSON.stringify(r.warnings));
    check('warning is a warning only, not an error',
      !r.errors.some(e => /customWindow\.bench/.test(e) && /in the past/.test(e)),
      JSON.stringify(r.errors));
  }

  console.log('\nTest 8: customWindow spanning effectiveWeek → no warning');
  {
    // window.end 2026-06-19 >= effectiveWeek 2026-06-15 → not stale
    const r = validateOverridesConfig({
      jobOverrides: {
        'X': {
          name: 'Active Job',
          customWindow: {
            bench: { start: '2026-06-08', end: '2026-06-19' },
          },
        },
      },
    }, { ...CTX, effectiveWeek: '2026-06-15' });
    check('spanning window produces no stale warning',
      !r.warnings.some(w => /entirely in the past/.test(w)),
      JSON.stringify(r.warnings));
  }

  console.log('\nTest 9: no effectiveWeek in opts → stale customWindow check skipped entirely');
  {
    // Without effectiveWeek, the check must be skipped (back-compat: context
    // without effectiveWeek means legacy caller, not a bug to warn about).
    const r = validateOverridesConfig({
      jobOverrides: {
        'X': {
          name: 'Old Job',
          customWindow: {
            bench: { start: '2026-01-05', end: '2026-01-09' },
          },
        },
      },
    }, CTX);  // CTX has no effectiveWeek
    check('no stale warning without effectiveWeek',
      !r.warnings.some(w => /entirely in the past/.test(w)),
      JSON.stringify(r.warnings));
  }

  console.log();
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} failure(s) of ${checks} checks:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`✅ All validate-config tests passed (${checks} checks).`);

})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
