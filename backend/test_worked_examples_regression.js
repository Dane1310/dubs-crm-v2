// PHASE 14 regression test — Dane's explicit worked examples from the
// Phase 14 handover doc. These are the EXACT numbers the leaderboard
// band logic must reproduce. DROP-IN file: run from the backend root
// (alongside server.js, config/, etc.):
//   node test_worked_examples_regression.js
const { EMAIL_BANDS, bandFor } = require('./config/leaderboardConfig');

const cases = [
  ['Set1 Agent1 daily',   35, 40,  'green'],
  ['Set1 Agent1 weekly', 110,200,  'orange'],
  ['Set1 Agent1 monthly',690,800,  'yellow'],
  ['Set1 Agent2 daily',   40, 40,  'green'],
  ['Set1 Agent2 weekly',  80,200,  'red'],
  ['Set1 Agent2 monthly',750,800,  'green'],
  ['Set2 Agent1 daily',   27, 40,  'orange'],
  ['Set2 Agent1 weekly', 110,200,  'orange'],
  ['Set2 Agent1 monthly',790,800,  'green'],
  ['Set2 Agent2 daily',   45, 40,  'green'],
  ['Set2 Agent2 weekly', 200,200,  'green'],
  ['Set2 Agent2 monthly',410,800,  'orange'],
];

let ok = 0, fail = 0;
for(const [label, actual, target, expected] of cases){
  const pct = Math.min(1.5, actual/target);
  const band = bandFor(pct, EMAIL_BANDS);
  const pass = band === expected;
  if(pass) ok++; else fail++;
  console.log(`${pass ? 'ok' : 'FAIL'} — ${label}: ${actual}/${target} = ${(pct*100).toFixed(1)}% -> ${band} (expected ${expected})`);
}
console.log(`\n${ok} passed, ${fail} failed`);
if(fail > 0) process.exit(1);
