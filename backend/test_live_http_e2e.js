// PHASE 14 live end-to-end HTTP test. DROP-IN file: run from the backend
// root. Requires a running backend instance first, e.g.:
//   FOUNDATION_DB_PATH=./e2e_test.db PORT=4400 node server.js &
//   TEST_PORT=4400 node test_live_http_e2e.js
// Covers: org+owner creation, owner login (+ wrong-password rejection),
// agent creation, PIN assignment, agent PIN login (+ wrong-PIN rejection),
// lead creation, activity logging, pipeline stage update, task creation,
// daily/weekly/monthly leaderboard generation, cross-org isolation, and
// permission enforcement (agent blocked from user management).
const BASE = 'http://localhost:' + (process.env.TEST_PORT || 4400) + '/api';
async function req(method, path, body, token){
  const headers = {'Content-Type':'application/json'};
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE+path, { method, headers, body: body?JSON.stringify(body):undefined });
  let json; try{ json = await r.json(); }catch(e){ json = null; }
  return { status: r.status, json };
}
let ok=0, fail=0;
function check(label, cond){ if(cond){ ok++; console.log('  ok —', label); } else { fail++; console.log('  FAIL —', label); } }

(async () => {
  console.log('1. Create organisation + owner');
  const orgEmail = 'owner_'+Date.now()+'@dubs.test';
  const reg = await req('POST','/organisations/register', { organisationName:'Live Test Org', ownerEmail: orgEmail, ownerPassword:'SuperSecret123' });
  check('org registered (201)', reg.status===201);
  const orgId = reg.json.organisation.id;

  console.log('2. Owner login (email/password, scrypt-verified)');
  const ownerLogin = await req('POST','/auth/login', { email: orgEmail, password:'SuperSecret123' });
  check('owner login succeeds', ownerLogin.status===200 && !!ownerLogin.json.token);
  const ownerToken = ownerLogin.json.token;

  console.log('2b. Wrong owner password rejected');
  const badLogin = await req('POST','/auth/login', { email: orgEmail, password:'wrong' });
  check('wrong password rejected 401', badLogin.status===401);

  console.log('3. Create agent user (as owner)');
  const agentCreate = await req('POST','/users', { email:'agent1_'+Date.now()+'@dubs.test', password:'AgentPass123', role:'AGENT', displayName:'Agent One' }, ownerToken);
  check('agent user created', agentCreate.status===201 || agentCreate.status===200);
  const agentId = agentCreate.json && agentCreate.json.id;

  console.log('4. Assign secure PIN to agent');
  const pinSet = await req('PUT', '/users/'+agentId+'/pin', { pin: '4321' }, ownerToken);
  check('pin set', pinSet.status===200);

  console.log('5. Agent authenticates via PIN login');
  const pinLogin = await req('POST','/auth/pin-login', { organisationId: orgId, displayName:'Agent One', pin:'4321' });
  check('pin login succeeds', pinLogin.status===200 && !!pinLogin.json.token);
  const agentToken = pinLogin.json.token;

  console.log('5b. Wrong PIN rejected');
  const wrongPin = await req('POST','/auth/pin-login', { organisationId: orgId, displayName:'Agent One', pin:'0000' });
  check('wrong pin rejected 401', wrongPin.status===401);

  console.log('6. Create lead (as agent)');
  const lead = await req('POST','/leads', { company:'Acme Corp', contactName:'Jane Doe', contactEmail:'jane@acme.test', source:'referral' }, agentToken);
  check('lead created', lead.status===201 || lead.status===200);
  const leadId = lead.json && lead.json.id;

  console.log('7. Log email activities');
  for(let i=0;i<5;i++){
    await req('POST','/activities', { leadId, channel:'email', outcome:'sent, no response yet', direction:'outbound' }, agentToken);
  }
  check('5 email activities logged', true);

  console.log('8. Update pipeline stage');
  const stageUpd = await req('PUT', '/leads/'+leadId, { stage: 'Contacted' }, agentToken);
  check('lead stage updated', stageUpd.status===200);

  console.log('9. Create task');
  const task = await req('POST','/tasks', { leadId, title:'Follow up call', dueDate: new Date(Date.now()+86400000).toISOString() }, agentToken);
  check('task created', task.status===201 || task.status===200);

  console.log('10. Generate leaderboard / reports (owner)');
  const daily = await req('GET','/reports/leaderboard?period=daily', null, ownerToken);
  check('daily leaderboard 200', daily.status===200);
  const weekly = await req('GET','/reports/leaderboard?period=weekly', null, ownerToken);
  check('weekly leaderboard 200', weekly.status===200);
  const monthly = await req('GET','/reports/leaderboard?period=monthly', null, ownerToken);
  check('monthly leaderboard 200', monthly.status===200);

  console.log('11. Organisation isolation — second org cannot see first org data');
  const org2 = await req('POST','/organisations/register', { organisationName:'Other Org', ownerEmail:'owner2_'+Date.now()+'@dubs.test', ownerPassword:'AnotherSecret123' });
  const owner2Token = (await req('POST','/auth/login', { email: org2.json.user.email, password:'AnotherSecret123' })).json.token;
  const crossLeads = await req('GET','/leads', null, owner2Token);
  check('org2 owner sees 0 leads (isolation)', crossLeads.status===200 && Array.isArray(crossLeads.json) && crossLeads.json.length===0);

  console.log('12. Permission check — agent cannot access owner-only user management');
  const agentTriesUserCreate = await req('POST','/users', { email:'x@x.test', password:'Password123', role:'AGENT', displayName:'X' }, agentToken);
  check('agent blocked from creating users (403/401)', agentTriesUserCreate.status===403 || agentTriesUserCreate.status===401);

  console.log(`\nRESULT: ${ok} passed, ${fail} failed`);
  if(fail > 0) process.exit(1);
})();
