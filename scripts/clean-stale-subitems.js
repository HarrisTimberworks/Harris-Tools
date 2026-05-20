#!/usr/bin/env node
/**
 * scripts/clean-stale-subitems.js — Phase 1 task A6.
 *
 * One-shot cleanup utility. Finds Crew Allocation subitems whose linked
 * Master PM job has Status = Complete, lists them, prompts before delete.
 *
 *   Usage:        node scripts/clean-stale-subitems.js
 *   Dry run:      DRY_RUN=1 node scripts/clean-stale-subitems.js
 *   Auth:         set MONDAY_API_TOKEN=...
 *
 * Background (docs/phase-1-manual-overrides-plan.md, Section B "Phase 1
 * enhancements — captured 2026-05-02", item #3): completed jobs leave
 * subitems on Crew Allocation parent rows. PATCH A in rebalance-schedule.js
 * preserves these subitems (the job isn't in the active set, so the script
 * doesn't delete-and-recreate it), but they pollute the capacity grid and
 * raise false 🚨 overage warnings. This utility cleans them up.
 *
 * Pattern mirrors scripts/validate-cross-training.js.
 */

// ────────────────────────────────────────────────────────────────────────
// Pure helper (unit-tested by scripts/test-clean-stale-subitems.js).
//
// Criterion (B-refined): a subitem is stale if its masterPmId resolves to a
// PL row with status === 'Complete' (clause: 'complete') OR resolves to no
// PL row at all (clause: 'orphan'). Subitems with masterPmId pointing to any
// other status — In Production, Not Started, On Hold, Cancelled, … — are
// explicitly preserved. The orphan clause covers the real failure mode the
// spec was written for: monday's PL→Master PM link is often null on Complete
// rows, so the strict-spec join misses most historically stale subitems.
//
// Each returned subitem carries `staleReason: 'complete' | 'orphan'` so the
// CLI can group output without re-deriving.
// ────────────────────────────────────────────────────────────────────────

function identifyStaleSubitems(subitems, plRows) {
  const statusByMpm = new Map();   // masterPmLink (as string) → status
  for (const r of plRows) {
    if (r?.masterPmLink == null) continue;     // can't be joined to any subitem
    statusByMpm.set(String(r.masterPmLink), r.status ?? null);
  }
  const stale = [];
  for (const s of subitems) {
    if (s?.masterPmId == null) continue;        // can't be evaluated; conservative skip
    const key = String(s.masterPmId);
    if (!statusByMpm.has(key)) {
      stale.push({ ...s, staleReason: 'orphan' });
    } else if (statusByMpm.get(key) === 'Complete') {
      stale.push({ ...s, staleReason: 'complete' });
    }
  }
  return stale;
}

module.exports = { identifyStaleSubitems };

// ────────────────────────────────────────────────────────────────────────
// CLI wrapper — only runs when invoked directly. Not unit-tested.
// ────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const readline = require('readline');

  const BOARD_PL = 18407601557;             // Production Load — workflow status lives here
  const BOARD_CREW_ALLOC = 18409529791;
  const COL_SUB_STATION = 'dropdown_mm2kex19';
  const COL_SUB_HOURS = 'numeric_mm2kv7rq';
  const COL_SUB_RELATED = 'board_relation_mm2kchhq';
  const COL_CA_WEEK = 'date_mm2kjth4';      // matches rebalance-schedule.js COL_CA.weekDate
  const COL_CA_CREW = 'text_mm2mhm0y';      // matches rebalance-schedule.js COL_CA.crewText
  const COL_PL_STATUS = 'color_mm26404x';   // matches rebalance-schedule.js COL_PL.status
  const COL_PL_MASTER_LINK = 'board_relation_mm26mhea';  // PL → Master PM
  const API_URL = 'https://api.monday.com/v2';
  const RATE_LIMIT_MS = 150;
  const DRY_RUN = process.env.DRY_RUN === '1';
  const TOKEN = process.env.MONDAY_API_TOKEN;

  if (!TOKEN) {
    console.error('ERROR: MONDAY_API_TOKEN not set.');
    process.exit(1);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function gql(query, variables) {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }

  async function loadAllSubitems() {
    // Walk the parent board (Crew Allocation), pulling parents + their
    // subitems together so we get parent row context (week, crew) cheaply.
    const subitems = [];
    let cursor = null;
    do {
      const q = `query($cursor: String) {
        boards(ids: [${BOARD_CREW_ALLOC}]) {
          items_page(limit: 50, cursor: $cursor) {
            cursor
            items {
              id
              column_values(ids: ["${COL_CA_WEEK}","${COL_CA_CREW}"]) { id text }
              subitems {
                id
                name
                column_values(ids: ["${COL_SUB_STATION}","${COL_SUB_HOURS}","${COL_SUB_RELATED}"]) {
                  id
                  text
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          }
        }
      }`;
      const data = await gql(q, { cursor });
      const page = data.boards[0].items_page;
      for (const parent of page.items) {
        const pcv = {};
        for (const v of parent.column_values) pcv[v.id] = v.text;
        for (const sub of (parent.subitems || [])) {
          const cv = {};
          for (const v of sub.column_values) cv[v.id] = v;
          subitems.push({
            id: sub.id,
            name: sub.name,
            parentId: parent.id,
            parentWeek: pcv[COL_CA_WEEK] || null,
            parentCrew: pcv[COL_CA_CREW] || null,
            station: cv[COL_SUB_STATION]?.text || null,
            hours: parseFloat(cv[COL_SUB_HOURS]?.text || '0'),
            masterPmId: cv[COL_SUB_RELATED]?.linked_item_ids?.[0] || null,
          });
        }
      }
      cursor = page.cursor;
    } while (cursor);
    return subitems;
  }

  async function loadJobStatuses() {
    // Workflow Status lives on Production Load, not Master PM (Master PM has
    // no Status column — verified by board-columns probe during A6 DRY_RUN).
    // Subitems link to Master PM via relatedJob, so we project PL rows by
    // their masterPmId link → { id: masterPmId, status: plStatus } so the
    // helper's lookup (subitem.masterPmId vs job.id) works unchanged.
    const jobs = [];
    let cursor = null;
    do {
      const q = `query($cursor: String) {
        boards(ids: [${BOARD_PL}]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values(ids: ["${COL_PL_STATUS}","${COL_PL_MASTER_LINK}"]) {
                id text
                ... on BoardRelationValue { linked_item_ids }
              }
            }
          }
        }
      }`;
      const data = await gql(q, { cursor });
      const page = data.boards[0].items_page;
      for (const it of page.items) {
        const cv = {};
        for (const v of it.column_values) cv[v.id] = v;
        jobs.push({
          plId: it.id,
          plName: it.name,
          masterPmLink: cv[COL_PL_MASTER_LINK]?.linked_item_ids?.[0] || null,
          status: cv[COL_PL_STATUS]?.text || null,
        });
      }
      cursor = page.cursor;
    } while (cursor);
    return jobs;
  }

  async function deleteSubitem(subitemId) {
    const q = `mutation { delete_item(item_id: ${subitemId}) { id } }`;
    await gql(q);
  }

  function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
  }

  function jobNameFromSubitem(sub) {
    // Subitem names follow the convention "Job Name — Station" (from
    // rebalance-schedule.js:1650). Strip the station to surface the job.
    if (!sub.name) return '(unnamed)';
    const idx = sub.name.lastIndexOf(' — ');
    return idx >= 0 ? sub.name.slice(0, idx) : sub.name;
  }

  async function main() {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
    console.log('Loading Crew Allocation subitems...');
    const subitems = await loadAllSubitems();
    console.log(`  ${subitems.length} subitems loaded.`);

    console.log('Loading Production Load job statuses (joined by Master PM link)...');
    const plRows = await loadJobStatuses();
    const completeCount = plRows.filter(j => j.status === 'Complete').length;
    const linkedCount   = plRows.filter(j => j.masterPmLink != null).length;
    console.log(`  ${plRows.length} PL rows loaded (${linkedCount} with Master PM link, ${completeCount} Status=Complete).\n`);

    const stale = identifyStaleSubitems(subitems, plRows);
    if (stale.length === 0) {
      console.log('✅ No stale subitems found. Nothing to do.');
      return;
    }

    const completeStale = stale.filter(s => s.staleReason === 'complete');
    const orphanStale   = stale.filter(s => s.staleReason === 'orphan');

    console.log(`Found ${stale.length} stale subitem(s):`);
    console.log(`  • Status=Complete on linked PL row: ${completeStale.length}`);
    console.log(`  • Orphan (no PL row resolves the Master PM link): ${orphanStale.length}\n`);

    function printGroup(label, group) {
      if (group.length === 0) return;
      console.log(`── ${label} (${group.length}) ──`);
      const byJob = new Map();
      for (const s of group) {
        const key = jobNameFromSubitem(s);
        if (!byJob.has(key)) byJob.set(key, []);
        byJob.get(key).push(s);
      }
      for (const [jobName, subs] of [...byJob.entries()].sort()) {
        const totalHours = subs.reduce((s, x) => s + (x.hours || 0), 0);
        console.log(`  ${jobName}  (${subs.length} subitem${subs.length === 1 ? '' : 's'}, ${totalHours}h total)`);
        subs.sort((a, b) => (a.parentWeek || '').localeCompare(b.parentWeek || ''));
        for (const s of subs) {
          console.log(`    • ${s.parentCrew || '?'} / ${s.parentWeek || '?'} / ${s.station || '?'} — ${s.hours}h  (subitem ${s.id})`);
        }
      }
      console.log('');
    }
    printGroup('Status=Complete', completeStale);
    printGroup('Orphan link',     orphanStale);

    if (DRY_RUN) {
      console.log(`(DRY RUN) Would delete ${stale.length} subitem(s). No changes made.`);
      return;
    }

    const ans = (await prompt(`Delete all ${stale.length} stale subitem(s)? (y/N) `)).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('Aborted — no changes made.');
      return;
    }

    let deleted = 0, failed = 0;
    for (const s of stale) {
      try {
        await deleteSubitem(s.id);
        deleted++;
        console.log(`  ✓ deleted ${s.id} (${jobNameFromSubitem(s)} / ${s.parentCrew} / ${s.parentWeek})`);
      } catch (e) {
        failed++;
        console.error(`  ✗ FAIL ${s.id}: ${e.message}`);
      }
      await sleep(RATE_LIMIT_MS);
    }

    console.log(`\n====== SUMMARY ======`);
    console.log(`Deleted: ${deleted}`);
    if (failed > 0) console.log(`Failed:  ${failed}`);
  }

  main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
