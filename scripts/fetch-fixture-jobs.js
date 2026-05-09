#!/usr/bin/env node
/**
 * Fetches the four canonical A2-test fixture jobs (non-pLam, finishingDays > 0)
 * from monday in the same shape `loadJobs()` uses internally, and prints them
 * as a JS literal suitable for pasting into scripts/test-finishing-cycle.js.
 *
 * Usage:
 *   $env:MONDAY_API_TOKEN = (Get-Content C:\Users\chris\Harris-Tools\.token).Trim()
 *   node scripts/fetch-fixture-jobs.js
 */

const https = require('https');

const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) { console.error('ERROR: MONDAY_API_TOKEN env var required'); process.exit(1); }

const FIXTURE_IDS = [
  '11693170191', // SH - McMorris
  '11693177783', // F&B - Quince Ave
  '11693164567', // Liz Stapp - Laundry Room
  '11693166446', // SHI - Huntington Hills
  '11693187209', // Gilbert - Dining Room & Range Hood
  '11693166519', // VV - Wrangler Way
];

const COL = {
  delivery: 'lookup_mm2n4nf4',
  finishingDays: 'numeric_mm2hdd1z',
  pLam: 'boolean_mm2f3589',
  eng: 'formula_mm2dpf4n',
  panel: 'formula_mm2dxy2k',
  bench: 'formula_mm2d25dk',
  prefin: 'formula_mm2df4w1',
  postfin: 'formula_mm2d5fmw',
  subtype: 'color_mm26yes1',
};

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.monday.com', path: '/v2', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN, 'API-Version': '2024-01', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const colIds = Object.values(COL).map(id => `"${id}"`).join(',');
  const q = `query { items(ids: [${FIXTURE_IDS.join(',')}]) { id name column_values(ids: [${colIds}]) { id text ... on FormulaValue { display_value } ... on MirrorValue { display_value } } } }`;
  const data = await gql(q);

  const fixtures = data.items.map(it => {
    const cv = {};
    for (const v of it.column_values) cv[v.id] = v.display_value || v.text || '';
    const pLamRaw = cv[COL.pLam];
    return {
      id: it.id,
      name: it.name,
      delivery: cv[COL.delivery] || null,
      finishingDays: parseInt(cv[COL.finishingDays] || '0', 10),
      pLam: pLamRaw === 'v' || pLamRaw === 'true' || pLamRaw === true,
      hours: {
        eng: parseFloat(cv[COL.eng] || '0'),
        panel: parseFloat(cv[COL.panel] || '0'),
        bench: parseFloat(cv[COL.bench] || '0'),
        prefin: parseFloat(cv[COL.prefin] || '0'),
        postfin: parseFloat(cv[COL.postfin] || '0'),
      },
      customWindow: null,
      parallelPostFin: false,
    };
  });

  console.log(JSON.stringify(fixtures, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
