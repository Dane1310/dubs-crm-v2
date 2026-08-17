// config/leaderboardConfig.js — ONE authoritative place for leaderboard
// targets, colour thresholds and weighting. routes/reports.js reads this;
// nothing else should hardcode a target or a weight.
//
// Values below reflect Dane's explicit instructions (Aug 2026 session):
// email targets 40/200/800 (daily/weekly/monthly), adherence bands,
// and the 100%-weighted scoring model. Calls have NO real target yet —
// deliberately left null rather than invented, per explicit instruction
// not to fabricate a calls target. When one exists, set CALLS.dailyTarget
// and flip CALLS.weight up from 0 — nothing else needs to change.

const EMAIL_TARGETS = { daily: 40, weekly: 200, monthly: 800 };

// Percentage-of-target thresholds — same proportional logic for all three
// periods, per instruction ("do not simply copy daily numbers into
// weekly/monthly"). Corrected 2026-08-16 against Dane's explicit worked
// examples (35/40=87.5%=GREEN, 30/40=75%=YELLOW, 20/40=50%=ORANGE,
// 27/40=67.5%=ORANGE) — the previous bands here (green at 100%) did not
// match those examples; this is a genuine calculation bug fix, not a
// re-interpretation.
// GREEN >=87.5%, YELLOW 75-87.49%, ORANGE 50-74.99%, RED <50%.
const EMAIL_BANDS = [
  { min: 0.875, band: 'green' },
  { min: 0.75, band: 'yellow' },
  { min: 0.50, band: 'orange' },
  { min: 0, band: 'red' },
];

const ADHERENCE_BANDS = [
  { min: 95, band: 'green' },
  { min: 90, band: 'yellow' },
  { min: 80, band: 'orange' },
  { min: 0, band: 'red' },
];

const CADENCE_BANDS = [
  { min: 90, band: 'green' },
  { min: 80, band: 'yellow' },
  { min: 70, band: 'orange' },
  { min: 0, band: 'red' },
];

// Client Response Rate and No-Conversion are deliberately NOT banded
// red/orange/yellow/green (explicit instruction) — comparative only:
// current leader = blue, everyone else = purple. No threshold table needed.

const WEIGHTS = {
  calls: 0.10,              // currently 0% effective — see effectiveWeights()
  emails: 0.20,
  adherence: 0.15,
  clientResponseRate: 0.15,
  conversionRate: 0.25,
  cadenceFollowUp: 0.15,
};

// Channel/outcome vocabulary — must match the frontend's actual <option>
// values (nl-channel / log-channel / log-outcome), not an invented one.
// Matching is case-insensitive on the backend side regardless, since nothing
// currently guarantees a client always sends the exact casing.
const EMAIL_CHANNEL = 'email';
const CALL_CHANNEL = 'call';

// "No response" family of outcomes — anything else counts as a response
// received. This is a judgement call, not a given: the schema has no
// dedicated boolean "client responded" field, so this list is the actual
// definition in force. If the real outcome vocabulary changes, update here.
const NO_RESPONSE_OUTCOMES = new Set([
  'sent, no response yet',
  'no response reached',
  'no response',
]);

const CONVERTED_STAGE = 'Converted';

function bandFor(value, bands) {
  for (const b of bands) if (value >= b.min) return b.band;
  return bands[bands.length - 1].band;
}

// Calls currently has weight 0 in the returned score because there is no
// real target/data to weight against yet (explicit instruction: do not let
// a missing metric distort ranking). Re-normalises the remaining weights
// to still sum to 1 so an employee isn't penalised for calls being unmeasured.
function effectiveWeights() {
  const w = { ...WEIGHTS, calls: 0 };
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const scale = sum > 0 ? 1 / sum : 0;
  for (const k of Object.keys(w)) w[k] = w[k] * scale;
  return w;
}

module.exports = {
  EMAIL_TARGETS, EMAIL_BANDS, ADHERENCE_BANDS, CADENCE_BANDS, WEIGHTS,
  EMAIL_CHANNEL, CALL_CHANNEL, NO_RESPONSE_OUTCOMES, CONVERTED_STAGE,
  bandFor, effectiveWeights,
};
