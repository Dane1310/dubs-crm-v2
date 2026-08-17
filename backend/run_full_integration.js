// run_full_integration.js — starts the Express app IN-PROCESS (no
// background/nohup needed), seeds two orgs + migrates real lead data,
// then runs the exact HTML-embedded client code against it.
// Eliminates cross-process/cross-call reliability issues entirely.

const fs = require('fs');
const path = require('path');

// Fresh DB for a clean, repeatable run.
const dbPath = path.join(__dirname, 'foundation.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { seedPermissionsAndDefaultRoles } = require('./permissions');
seedPermissionsAndDefaultRoles();

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/protected'));
app.use('/api', require('./routes/leads'));
app.use('/api', require('./routes/activities'));

const { makeApiClient } = require('./extracted_client.js');
const { migrate } = require('./migrate_leads.js');

async function main() {
  const server = app.listen(4001); // different port, avoids any stale process on 4000
  const BASE = 'http://localhost:4001/api';

  try {
    // --- seed: two organisations ---
    const regA = await (await fetch(`${BASE}/organisations/register`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ organisationName: 'Org A', ownerEmail: 'owner@orga.test', ownerPassword: 'correcthorsebattery' })
    })).json();
    const regB = await (await fetch(`${BASE}/organisations/register`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ organisationName: 'Org B', ownerEmail: 'owner@orgb.test', ownerPassword: 'correcthorsebattery' })
    })).json();
    console.log('Seeded Org A:', regA.organisation.id, '| Org B:', regB.organisation.id);

    // --- seed: migrate real historical lead data into Org A ---
    const migResult = migrate('legacy_leads_export.json', regA.organisation.id, 'integration test seed');
    console.log('Migration:', migResult.migratedCount, '/', migResult.sourceCount, 'migrated, ', migResult.rejected.length, 'rejected');

    // --- now the real integration test, using the client code extracted verbatim from the HTML ---
    const results = [];
    const log = (label, cond, extra) => results.push({ label, pass: !!cond, extra });

    const apiA = makeApiClient(BASE);
    const apiB = makeApiClient(BASE);

    const loginA = await apiA.login('owner@orga.test', 'correcthorsebattery');
    log('LOGIN — Org A owner', !!loginA.token);
    const loginB = await apiB.login('owner@orgb.test', 'correcthorsebattery');
    log('LOGIN — Org B owner', !!loginB.token);

    const leads = await apiA.listLeads();
    log('VIEW LEADS — real migrated leads returned', leads.length > 0, { count: leads.length });
    const leadId = leads[0].id;
    const lead = await apiA.getLead(leadId);
    log('VIEW LEAD — single fetch matches list', lead.id === leadId);

    let contact = null;
    if (lead.contact_id) {
      contact = await apiA.getContact(lead.contact_id);
      log('OPEN CONTACT — loads and matches lead', !!contact && contact.id === lead.contact_id);
    } else {
      log('OPEN CONTACT — lead had none (not a failure)', true);
    }

    const activity = await apiA.createActivity({ leadId, channel: 'call', direction: 'outbound', outcome: 'Answered', notes: 'Integration test call' });
    log('CREATE ACTIVITY', !!activity.id && activity.lead_id === leadId);

    const historyBefore = await apiA.listActivitiesForLead(leadId);
    log('ACTIVITY HISTORY — new activity appears', historyBefore.some(a => a.id === activity.id));

    const task = await apiA.createTask({ leadId, dueDate: '2026-09-01', priority: 'high', originatingActivityId: activity.id });
    log('CREATE TASK', !!task.id && task.status === 'open');

    const completed = await apiA.completeTask(task.id);
    log('COMPLETE TASK', completed.status === 'done');

    // Simulate a page refresh: brand-new client instance, fresh login, re-fetch everything
    const apiA2 = makeApiClient(BASE);
    await apiA2.login('owner@orga.test', 'correcthorsebattery');
    const reloadedLead = await apiA2.getLead(leadId);
    const reloadedHistory = await apiA2.listActivitiesForLead(leadId);
    const reloadedTask = await apiA2.getLead ? null : null; // n/a
    log('REFRESH — lead persists', reloadedLead.id === leadId);
    log('REFRESH — activity persists', reloadedHistory.some(a => a.id === activity.id));

    try {
      await apiB.getLead(leadId);
      log('ORG ISOLATION — Org B blocked from Org A lead', false, 'did not throw');
    } catch (e) { log('ORG ISOLATION — Org B blocked from Org A lead', e.status === 404, { status: e.status }); }

    try {
      await apiB.listActivitiesForLead(leadId);
      log('ORG ISOLATION — Org B blocked from Org A activity history', false, 'did not throw');
    } catch (e) { log('ORG ISOLATION — Org B blocked from Org A activity history', e.status === 404, { status: e.status }); }

    console.log('\n=== INTEGRATION TEST RESULTS (exact HTML-embedded client code) ===');
    for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + '  —  ' + r.label + (r.pass ? '' : '  [' + JSON.stringify(r.extra) + ']'));
    const allPass = results.every(r => r.pass);
    console.log('\nOVERALL:', allPass ? 'ALL PASS' : 'SOME FAILED');

  } finally {
    server.close();
  }
}

main().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });