// integration_test.js — exercises the EXACT makeApiClient code extracted
// verbatim from crm_integrated.html (see extracted_client.js), simulating
// the flow: login -> view lead -> open contact -> create activity ->
// create/complete task -> refresh -> confirm persistence, plus org isolation.

const { makeApiClient } = require('./extracted_client.js');
const db = require('./db');

async function main() {
  const results = [];
  const log = (label, cond, extra) => { results.push({ label, pass: !!cond, extra }); };

  const apiA = makeApiClient('http://localhost:4000/api');
  const apiB = makeApiClient('http://localhost:4000/api');

  // --- LOGIN ---
  const loginA = await apiA.login('owner@orga.test', 'correcthorsebattery');
  log('LOGIN — Org A owner', !!loginA.token);
  const loginB = await apiB.login('owner@orgb.test', 'correcthorsebattery');
  log('LOGIN — Org B owner', !!loginB.token);

  // --- VIEW LEAD ---
  const leads = await apiA.listLeads();
  log('VIEW LEADS — list returns real migrated leads', leads.length > 0, { count: leads.length });
  const leadId = leads[0].id;
  const lead = await apiA.getLead(leadId);
  log('VIEW LEAD — single lead fetch matches list', lead.id === leadId);

  // --- OPEN CONTACT ---
  let contact = null;
  if (lead.contact_id) {
    contact = await apiA.getContact(lead.contact_id);
    log('OPEN CONTACT — contact loads and belongs to this lead', !!contact && contact.id === lead.contact_id, contact);
  } else {
    log('OPEN CONTACT — lead has no linked contact (skipped, not a failure)', true);
  }

  // --- CREATE ACTIVITY ---
  const activity = await apiA.createActivity({ leadId, channel: 'call', direction: 'outbound', outcome: 'Answered', notes: 'Integration test call' });
  log('CREATE ACTIVITY', !!activity.id && activity.lead_id === leadId);

  // --- view activity history for the lead (exercises the new endpoint) ---
  const historyBefore = await apiA.listActivitiesForLead(leadId);
  log('ACTIVITY HISTORY — new activity appears in lead history', historyBefore.some(a => a.id === activity.id), { count: historyBefore.length });

  // --- CREATE TASK ---
  const task = await apiA.createTask({ leadId, dueDate: '2026-09-01', priority: 'high', originatingActivityId: activity.id });
  log('CREATE TASK', !!task.id && task.status === 'open');

  // --- COMPLETE TASK ---
  const completed = await apiA.completeTask(task.id);
  log('COMPLETE TASK', completed.status === 'done');

  // --- REFRESH -> CONFIRM PERSISTENCE (re-fetch from a fresh client instance, simulating a page reload) ---
  const apiA2 = makeApiClient('http://localhost:4000/api');
  await apiA2.login('owner@orga.test', 'correcthorsebattery');
  const reloadedLead = await apiA2.getLead(leadId);
  const reloadedHistory = await apiA2.listActivitiesForLead(leadId);
  log('REFRESH — lead still correct after simulated reload', reloadedLead.id === leadId);
  log('REFRESH — activity still present after simulated reload', reloadedHistory.some(a => a.id === activity.id));

  // --- ORGANISATION ISOLATION ---
  try {
    await apiB.getLead(leadId);
    log('ORG ISOLATION — Org B blocked from Org A lead', false, 'did NOT throw — SECURITY ISSUE');
  } catch (e) {
    log('ORG ISOLATION — Org B blocked from Org A lead', e.status === 404, { status: e.status });
  }
  try {
    await apiB.listActivitiesForLead(leadId);
    log('ORG ISOLATION — Org B blocked from Org A activity history', false, 'did NOT throw — SECURITY ISSUE');
  } catch (e) {
    log('ORG ISOLATION — Org B blocked from Org A activity history', e.status === 404, { status: e.status });
  }

  console.log('\n=== INTEGRATION TEST RESULTS (using the exact HTML-embedded client code) ===');
  for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '  —  ' + r.label);
  const allPass = results.every(r => r.pass);
  console.log('\nOVERALL:', allPass ? 'ALL PASS' : 'SOME FAILED');
  require('fs').writeFileSync('/tmp/integration_results.json', JSON.stringify({ allPass, results }, null, 2));
}

main().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });