const {
  EMAIL_TARGETS, EMAIL_BANDS, ADHERENCE_BANDS, CADENCE_BANDS,
  EMAIL_CHANNEL, NO_RESPONSE_OUTCOMES, CONVERTED_STAGE,
  bandFor, effectiveWeights,
} = require('./config/leaderboardConfig');

// ---- period boundaries (server clock; no timezone param yet — a real
// gap if agents span timezones, not solved here) ----
function periodBounds(period, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'daily') {
    return { start, end: now };
  }
  if (period === 'weekly') {
    // Monday-start week, per explicit instruction.
    const day = start.getDay(); // 0=Sun..6=Sat
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    start.setDate(start.getDate() + diffToMonday);
    return { start, end: now };
  }
  // monthly
  start.setDate(1);
  return { start, end: now };
}

function inRange(isoString, start, end) {
  if (!isoString) return false;
  const t = new Date(isoString).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

// Computes one employee's metrics for one period, from real activity/lead/
// task rows already loaded for the whole org (avoids N+1 queries per agent).
function computeAgentPeriod(user, period, { start, end }, allActivities, allLeads, allTasks) {
  const userActivities = allActivities.filter(a => a.user_id === user.id && inRange(a.occurred_at, start, end));

  const emailCount = userActivities.filter(a => (a.channel || '').toLowerCase() === EMAIL_CHANNEL).length;
  const target = EMAIL_TARGETS[period];
  const emailPct = target > 0 ? Math.min(1.5, emailCount / target) : 0; // capped display, not capped score
  const emailBand = bandFor(emailPct, EMAIL_BANDS);

  // Adherence: % of days-with-activity within the period so far, out of
  // elapsed days. Simplistic (does not yet exclude weekends/leave) — a
  // real "scheduled work day" calendar does not exist in this schema yet.
  const daysElapsed = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
  const activeDays = new Set(userActivities.map(a => (a.occurred_at || '').slice(0, 10))).size;
  const adherencePct = Math.min(100, Math.round((activeDays / daysElapsed) * 100));
  const adherenceBand = bandFor(adherencePct, ADHERENCE_BANDS);

  // Client response rate: outbound activities whose outcome is NOT in the
  // "no response" set, divided by total outbound activities in the period.
  // Judgement call documented in config/leaderboardConfig.js — there is no
  // dedicated "responded" boolean in the schema.
  const outbound = userActivities.filter(a => (a.direction || 'outbound') === 'outbound');
  const responded = outbound.filter(a => !NO_RESPONSE_OUTCOMES.has((a.outcome || '').trim().toLowerCase()));
  const clientResponseRate = outbound.length > 0 ? Math.round((responded.length / outbound.length) * 100) : null; // null = no data, not 0%

  // Touched leads in period = leads this user owns with at least one
  // activity in the period (or the lead itself was created in-period).
  const touchedLeadIds = new Set(userActivities.filter(a => a.lead_id).map(a => a.lead_id));
  const ownedLeads = allLeads.filter(l => l.owner_user_id === user.id);
  const touchedLeads = ownedLeads.filter(l => touchedLeadIds.has(l.id));
  const converted = touchedLeads.filter(l => l.stage === CONVERTED_STAGE).length;
  const conversionRate = touchedLeads.length > 0 ? Math.round((converted / touchedLeads.length) * 100) : null;
  const noConversion = touchedLeads.length - converted;

  // Cadence follow-up %: of touched, non-converted, non-dead leads, how
  // many have a genuine future follow_up_date OR an open task with a
  // future due_date. Archived/Dead leads are excluded — not eligible.
  const eligible = touchedLeads.filter(l => l.stage !== CONVERTED_STAGE && l.stage !== 'Dead' && !l.archived);
  const openTasksByLead = {};
  for (const t of allTasks) {
    if (t.status === 'open' && t.due_date && new Date(t.due_date) >= new Date()) {
      openTasksByLead[t.lead_id] = true;
    }
  }
  const withFollowUp = eligible.filter(l => {
    const hasFutureDate = l.follow_up_date && new Date(l.follow_up_date) >= new Date();
    return hasFutureDate || openTasksByLead[l.id];
  });
  const cadenceFollowUpPct = eligible.length > 0 ? Math.round((withFollowUp.length / eligible.length) * 100) : null;
  const cadenceBand = cadenceFollowUpPct === null ? null : bandFor(cadenceFollowUpPct, CADENCE_BANDS);

  const callCount = userActivities.filter(a => (a.channel || '').toLowerCase() === 'call').length;

  return {
    emails: { count: emailCount, target, percentOfTarget: Math.round(emailPct * 100), band: emailBand },
    adherence: { percent: adherencePct, band: adherenceBand },
    clientResponseRate: { percent: clientResponseRate, respondedCount: responded.length, outboundCount: outbound.length },
    conversion: { touched: touchedLeads.length, converted, conversionRate, noConversion },
    cadenceFollowUp: { percent: cadenceFollowUpPct, band: cadenceBand, eligible: eligible.length, withFollowUp: withFollowUp.length },
    calls: { count: callCount, target: null, note: 'no target configured yet' },
  };
}

function weightedScore(metrics) {
  const w = effectiveWeights();
  let score = 0;
  score += Math.min(1, metrics.emails.percentOfTarget / 100) * 100 * w.emails;
  score += metrics.adherence.percent * w.adherence;
  score += (metrics.clientResponseRate.percent ?? 0) * w.clientResponseRate;
  score += (metrics.conversion.conversionRate ?? 0) * w.conversionRate;
  score += (metrics.cadenceFollowUp.percent ?? 0) * w.cadenceFollowUp;
  return Math.round(score);
}


module.exports = { periodBounds, inRange, computeAgentPeriod, weightedScore };
