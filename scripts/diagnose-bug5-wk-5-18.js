#!/usr/bin/env node
/**
 * Bug 5 diagnostic — enumerate subitems landing on wk 2026-05-18 Crew
 * Allocation parents and classify each as:
 *   - "active job — will be deleted+recreated" (does NOT pre-load committed)
 *   - "non-active job — PRE-LOADS committed" (CONTRIBUTES to the gap)
 *   - "no masterPmId — PRE-LOADS committed" (likely orphan/manual sub)
 *
 * Bug 5 observation: capacityGrid shows Bob=42/40, Ian=21/20, Paisios=19.57/20
 * on wk 5/18 while sum(placements) shows Bob=32.4, Ian=11.4, Paisios=11.57.
 * Gaps: 9.6 / 9.6 / 8.0 = 27.2h. This script identifies which sub rows
 * contribute those 27.2h.
 *
 * Read-only. Does NOT modify monday and does NOT write any plan file.
 * Requires env var MONDAY_API_TOKEN.
 *
 * Usage:
 *   set MONDAY_API_TOKEN=...
 *   node scripts/diagnose-bug5-wk-5-18.js
 */

const TARGET_WEEK = '2026-05-18';
const TARGET_CREWS = ['Bob', 'Ian', 'Paisios'];  // crews with observed gap

const API_URL = 'https://api.monday.com/v2';
const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) {
  console.error('ERROR: MONDAY_API_TOKEN env var required');
  console.error('Set it via:  set MONDAY_API_TOKEN=your_token_here');
  process.exit(1);
}

// Board + column IDs MUST match scripts/rebalance-schedule.js
const BOARD_PL = 18407601557;
const BOARD_CREW_SUBITEMS = 18409530171;
const COL_PL_STATUS = 'color_mm26404x';
const COL_PL_MASTER = 'board_relation_mm26mhea';
const COL_CA_WEEK = 'date_mm2kjth4';
const COL_CA_CREW = 'text_mm2mhm0y';
const COL_SUB_STATION = 'dropdown_mm2kex19';
const COL_SUB_HOURS = 'numeric_mm2kv7rq';
const COL_SUB_RELATED = 'board_relation_mm2kchhq';

const ACTIVE_STATUSES = new Set(['Not Started', 'Scheduled', 'Ready to Schedule', 'Finishing']);

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

async function loadActiveJobMasterIds() {
  const q = `query {
    boards(ids: [${BOARD_PL}]) {
      items_page(limit: 100) {
        items {
          id name
          column_values(ids: ["${COL_PL_STATUS}","${COL_PL_MASTER}"]) {
            id text
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }
    }
  }`;
  const data = await gql(q);
  const items = data.boards[0].items_page.items;
  const activeMasterIds = new Set();
  const jobInfo = {};  // masterPmId → {name, status}
  for (const it of items) {
    const cv = {};
    for (const v of it.column_values) cv[v.id] = v;
    const status = cv[COL_PL_STATUS]?.text || 'Not Started';
    const masterPmId = cv[COL_PL_MASTER]?.linked_item_ids?.[0] || null;
    if (masterPmId) {
      jobInfo[masterPmId] = { jobName: it.name, plbStatus: status, plbId: it.id };
      if (ACTIVE_STATUSES.has(status)) activeMasterIds.add(masterPmId);
    }
  }
  return { activeMasterIds, jobInfo };
}

async function loadSubitemsForWeek(targetWeek) {
  const q = `query($cursor: String) {
    boards(ids: [${BOARD_CREW_SUBITEMS}]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items {
          id name
          parent_item {
            id
            column_values(ids: ["${COL_CA_WEEK}","${COL_CA_CREW}"]) { id text }
          }
          column_values(ids: ["${COL_SUB_STATION}","${COL_SUB_HOURS}","${COL_SUB_RELATED}"]) {
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
      if (parentCv[COL_CA_WEEK] !== targetWeek) continue;
      results.push({
        id: it.id,
        name: it.name,
        parentId: it.parent_item?.id,
        parentWeek: parentCv[COL_CA_WEEK],
        parentCrew: parentCv[COL_CA_CREW],
        station: cv[COL_SUB_STATION]?.text,
        hours: parseFloat(cv[COL_SUB_HOURS]?.text || '0'),
        masterPmId: cv[COL_SUB_RELATED]?.linked_item_ids?.[0] || null,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return results;
}

(async () => {
  console.log(`Loading PLB jobs (active status check)...`);
  const { activeMasterIds, jobInfo } = await loadActiveJobMasterIds();
  console.log(`  ${activeMasterIds.size} active jobs found.`);

  console.log(`\nLoading subitems on parents @ ${TARGET_WEEK}...`);
  const subs = await loadSubitemsForWeek(TARGET_WEEK);
  console.log(`  ${subs.length} subs on wk ${TARGET_WEEK} parents.`);

  const tally = {};
  for (const crew of TARGET_CREWS) tally[crew] = { willDelete: [], preLoad: [] };

  for (const s of subs) {
    if (!TARGET_CREWS.includes(s.parentCrew)) continue;
    const bucket = tally[s.parentCrew];
    if (s.masterPmId && activeMasterIds.has(s.masterPmId)) {
      bucket.willDelete.push(s);
    } else {
      bucket.preLoad.push(s);
    }
  }

  for (const crew of TARGET_CREWS) {
    const { willDelete, preLoad } = tally[crew];
    const delHrs = willDelete.reduce((s, x) => s + x.hours, 0);
    const preHrs = preLoad.reduce((s, x) => s + x.hours, 0);
    console.log(`\n=== ${crew} @ ${TARGET_WEEK} ===`);
    console.log(`  ${willDelete.length} active-job subs (${delHrs.toFixed(2)}h) — will be deleted+recreated`);
    console.log(`  ${preLoad.length} non-active-job subs (${preHrs.toFixed(2)}h) — PRE-LOADS committed`);
    if (preLoad.length > 0) {
      console.log('  Pre-loading rows:');
      for (const s of preLoad) {
        const info = s.masterPmId ? jobInfo[s.masterPmId] : null;
        const tag = info
          ? `${info.jobName} [PLB status="${info.plbStatus}"]`
          : (s.masterPmId
              ? `(masterPmId=${s.masterPmId} — not found in PLB)`
              : '(no masterPmId — orphan or manual sub)');
        console.log(`    - id=${s.id}  ${s.station}  ${s.hours}h  ←  ${tag}`);
        console.log(`      name="${s.name}"`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  let totalPre = 0;
  for (const crew of TARGET_CREWS) {
    totalPre += tally[crew].preLoad.reduce((s, x) => s + x.hours, 0);
  }
  console.log(`Total pre-loaded hours across ${TARGET_CREWS.join(', ')} on ${TARGET_WEEK}: ${totalPre.toFixed(2)}h`);
  console.log(`(Observed gap in 2026-05-18 plan log: 27.2h — Bob 9.6 + Ian 9.6 + Paisios 8.0)`);
})().catch(e => { console.error(e); process.exit(1); });
