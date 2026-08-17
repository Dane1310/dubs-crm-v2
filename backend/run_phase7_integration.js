// run_phase7_integration.js — Phase 7 addition: Pipeline view (GET /api/pipeline)
// grouping leads by canonical stage, plus server-side stage-vocabulary
// validation on lead create/update. Same in-process pattern as prior suites,
// run AFTER run_full_integration.js and run_phase6_integration.js.

const fs = require('fs');
const path = require('path');

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
const db = require('./db');
const { hashPassword } = require('./auth');
const userRepo = require('./repositories/userRepository');

const results = [];
function check(name, cond) { results.push({ name, pass: !!cond }); }

async function main() {
  const server = app.listen(4003);
  const BASE = 'http://localhost:4003/api';

  try {
    const regA = await (await fetch(`${BASE}/organisations/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organisationName: 'Pipeline Test Org', ownerEmail: 'owner7@test.com', ownerPassword: 'password123' })
    })).json();
    const orgAId = regA.organisation.id;

    const regB = await (await fetch(`${BASE}/organisations/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organisationName: 'Pipeline Test Org B', ownerEmail: 'ownerB7@test.com', ownerPassword: 'password123' })
    })).json();
    const orgBId = regB.organisation.id;

    const owner = makeApiClient(BASE);
    await owner.login('owner7@test.com', 'password123');

    const ownerB = makeApiClient(BASE);
    await ownerB.login('ownerB7@test.com', 'password123');

    // An AGENT user in org A, to test own-vs-org pipeline scoping.
    const { hash, salt } = hashPassword('agentpass123');
    const agentUser = userRepo.createUser({
      organisationId: orgAId, email: 'agent7@test.com', passwordHash: hash, passwordSalt: salt, roleId: 'role_default_agent'
    });
    const agent = makeApiClient(BASE);
    await agent.login('agent7@test.com', 'agentpass123');

    // --- create leads across several stages, owned by owner and by agent ---
    const l1 = await owner.createLead({ company: 'New Co', stage: 'New' });
    const l2 = await owner.createLead({ company: 'Contacted Co', stage: 'Contacted' });
    const l3 = await owner.createLead({ company: 'Engaged Co' }); // defaults to New
    await owner.updateLead(l3.id, { stage: 'Engaged' });
    const l4 = await agent.createLead({ company: 'Agent Lead', stage: 'Contacted' });
    const l5 = await owner.createLead({ company: 'To Be Archived', stage: 'Dead' });
    await owner.archiveLead(l5.id);

    // --- STAGE VALIDATION ---
    const badCreate = await fetch(`${BASE}/leads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + owner.getToken() },
      body: JSON.stringify({ company: 'Bad Stage Co', stage: 'NotAStage' })
    });
    check('CREATE — invalid stage rejected (400)', badCreate.status === 400);

    const badUpdate = await fetch(`${BASE}/leads/${l1.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + owner.getToken() },
      body: JSON.stringify({ stage: 'NotAStage' })
    });
    check('UPDATE — invalid stage rejected (400)', badUpdate.status === 400);

    const stillNew = await owner.getLead(l1.id);
    check('UPDATE — rejected stage did not mutate the lead', stillNew.stage === 'New');

    // --- PIPELINE — org view (owner has data.view.org) ---
    const pipelineOrg = await owner.getPipeline();
    check('PIPELINE — response has stages array', Array.isArray(pipelineOrg.stages));
    check('PIPELINE — canonical stage order preserved', pipelineOrg.stages.map(s => s.stage).slice(0, 6).join(',') === 'New,Contacted,Engaged,Follow-up scheduled,Converted,Dead');

    const newGroup = pipelineOrg.stages.find(s => s.stage === 'New');
    const contactedGroup = pipelineOrg.stages.find(s => s.stage === 'Contacted');
    const engagedGroup = pipelineOrg.stages.find(s => s.stage === 'Engaged');
    check('PIPELINE — New stage contains l1', newGroup.leads.some(l => l.id === l1.id));
    check('PIPELINE — Contacted stage contains l2 AND l4 (org view sees agent lead too)', contactedGroup.leads.some(l => l.id === l2.id) && contactedGroup.leads.some(l => l.id === l4.id));
    check('PIPELINE — Engaged stage contains l3', engagedGroup.leads.some(l => l.id === l3.id));

    const deadGroup = pipelineOrg.stages.find(s => s.stage === 'Dead');
    check('PIPELINE — archived lead excluded from Dead group', !deadGroup.leads.some(l => l.id === l5.id));
    check('PIPELINE — total excludes archived lead', pipelineOrg.total === 4);

    // --- PIPELINE — own-scoped view for AGENT ---
    const pipelineAgent = await agent.getPipeline();
    const agentContacted = pipelineAgent.stages.find(s => s.stage === 'Contacted');
    check('PIPELINE — agent sees only own lead in Contacted', agentContacted.leads.length === 1 && agentContacted.leads[0].id === l4.id);
    check('PIPELINE — agent total is own-scoped (1, not org total)', pipelineAgent.total === 1);

    // --- CROSS-ORG isolation ---
    const pipelineB = await ownerB.getPipeline();
    check('PIPELINE — org B pipeline is empty (no cross-org leak)', pipelineB.total === 0);

    // --- unauthenticated ---
    const noAuth = await fetch(`${BASE}/pipeline`);
    check('PIPELINE — unauthenticated request blocked (401)', noAuth.status === 401);

  } finally {
    server.close();
  }

  console.log('\n=== PHASE 7 TEST RESULTS ===');
  let allPass = true;
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  —  ' + r.name);
    if (!r.pass) allPass = false;
  }
  console.log(`\nOVERALL: ${allPass ? `ALL ${results.length} PASS` : 'SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });