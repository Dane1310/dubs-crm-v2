// Focused tests for the four frontend/backend disconnects closed in this
// pass: GET /reports/summary, GET /search, GET /tasks, GET /contacts/:id/activities.
//
// HONEST LIMITATION: there is no network egress in this sandbox to `npm
// install express`, so these are not HTTP-level tests (integration_test.js
// still can't run, same gap as previous passes). Instead this exercises
// the exact same repository calls, permission checks, and computation each
// route performs, at the same layer test_phase9_data_foundation.js already
// uses — genuine coverage of the new logic, just not through a live server.

process.env.FOUNDATION_DB_PATH = require('path').join(__dirname, 'test_phase9b.db');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });

require('./permissions').seedPermissionsAndDefaultRoles();
const { hasPermission } = require('./permissions');
const orgRepo = require('./repositories/organisationRepository');
const userRepo = require('./repositories/userRepository');
const leadRepo = require('./repositories/leadRepository');
const contactRepo = require('./repositories/contactRepository');
const activityRepo = require('./repositories/activityRepository');
const taskRepo = require('./repositories/taskRepository');
const { hashPassword } = require('./auth');

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok — ' + msg); }

// --- Fixtures: two orgs, so every test below can double as an isolation check ---
const org = orgRepo.createOrganisation('Gap Closure Org');
const otherOrg = orgRepo.createOrganisation('Other Org');

const { hash: mHash, salt: mSalt } = hashPassword('managerpass123');
const manager = userRepo.createUser({ organisationId: org.id, email: 'manager@test.com', passwordHash: mHash, passwordSalt: mSalt, roleId: 'role_default_manager' });

const { hash: aHash, salt: aSalt } = hashPassword('agentpass123');
const agentA = userRepo.createUser({ organisationId: org.id, email: 'agentA@test.com', passwordHash: aHash, passwordSalt: aSalt, roleId: 'role_default_agent' });
const { hash: bHash, salt: bSalt } = hashPassword('agentpass123');
const agentB = userRepo.createUser({ organisationId: org.id, email: 'agentB@test.com', passwordHash: bHash, passwordSalt: bSalt, roleId: 'role_default_agent' });

const { hash: oHash, salt: oSalt } = hashPassword('otherpass123');
const otherOrgUserRaw = userRepo.createUser({ organisationId: otherOrg.id, email: 'other@test.com', passwordHash: oHash, passwordSalt: oSalt, roleId: 'role_default_agent' });

// createUser() returns a slim camelCase shape; the real row (with the
// snake_case role_id every permission check + route handler actually uses,
// since req.user comes from the sessions/users join) is fetched back the
// same way requireAuth would populate req.user.
const managerRow = userRepo.findByIdScoped(manager.id, org.id);
const agentARow = userRepo.findByIdScoped(agentA.id, org.id);
const agentBRow = userRepo.findByIdScoped(agentB.id, org.id);
const otherOrgUser = userRepo.findByIdScoped(otherOrgUserRaw.id, otherOrg.id);

// Leads: 2 owned by agentA (1 Converted), 1 owned by agentB, 1 archived, plus a decoy in the other org.
const leadA1 = leadRepo.createLead({ organisationId: org.id, company: 'Acme Corp', source: 'CIPC Sourced', stage: 'Converted', ownerUserId: agentA.id, ownerNameRaw: agentA.email });
const leadA2 = leadRepo.createLead({ organisationId: org.id, company: 'Acme Widgets', source: 'CIPC Sourced', stage: 'Contacted', ownerUserId: agentA.id, ownerNameRaw: agentA.email });
const leadB1 = leadRepo.createLead({ organisationId: org.id, company: 'Beta Ltd', source: 'CIPC Sourced', stage: 'New', ownerUserId: agentB.id, ownerNameRaw: agentB.email });
const leadArchived = leadRepo.createLead({ organisationId: org.id, company: 'Zombie Inc', source: 'CIPC Sourced', stage: 'Dead', ownerUserId: agentB.id, ownerNameRaw: agentB.email });
leadRepo.archiveScoped(leadArchived.id, org.id);
leadRepo.createLead({ organisationId: otherOrg.id, company: 'Acme Decoy', source: 'CIPC Sourced', stage: 'New', ownerUserId: otherOrgUser.id, ownerNameRaw: otherOrgUser.email });

const contactA = contactRepo.createContact({ organisationId: org.id, name: 'Jane Acme', email: 'jane@acme.test', phone: '0821234567' });
contactRepo.createContact({ organisationId: otherOrg.id, name: 'Decoy Contact', email: 'decoy@acme.test', phone: null });

activityRepo.createActivity({ organisationId: org.id, leadId: leadA1.id, userId: agentA.id, channel: 'call', outcome: 'Interested', notes: 'note' });
activityRepo.createActivity({ organisationId: org.id, contactId: contactA.id, userId: agentA.id, channel: 'email', outcome: 'Interested', notes: 'note' });
activityRepo.createActivity({ organisationId: org.id, leadId: leadB1.id, userId: agentB.id, channel: 'call', outcome: 'No response', notes: 'note' });

const taskOpenPast = taskRepo.createTask({ organisationId: org.id, leadId: leadA1.id, assignedUserId: agentA.id, dueDate: '2020-01-01', priority: 'high' });
taskRepo.createTask({ organisationId: org.id, leadId: leadB1.id, assignedUserId: agentB.id, dueDate: '2099-01-01', priority: 'low' });
const taskDone = taskRepo.createTask({ organisationId: org.id, leadId: leadA1.id, assignedUserId: agentA.id, dueDate: '2020-01-01', priority: 'medium' });
taskRepo.completeScoped(taskDone.id, org.id, agentA.id);

// =====================================================================
// 1. REPORTS SUMMARY — replicates routes/reports.js exactly
// =====================================================================
console.log('1. GET /reports/summary');
function computeSummary(user) {
  const orgId = user.organisation_id;
  const canSeeOrg = hasPermission(user.role_id, 'data.view.org');
  const ownerFilter = canSeeOrg ? {} : { ownerUserId: user.id };
  const activeLeads = leadRepo.listScoped(orgId, ownerFilter);
  const allLeads = leadRepo.listScoped(orgId, Object.assign({}, ownerFilter, { includeArchived: true }));
  const archivedCount = allLeads.length - activeLeads.length;
  const converted = activeLeads.filter(l => l.stage === 'Converted').length;
  const conversionRate = activeLeads.length > 0 ? (converted / activeLeads.length) * 100 : null;
  const activityFilter = canSeeOrg ? {} : { userId: user.id };
  const activities = activityRepo.listScoped(orgId, activityFilter);
  const taskFilter = canSeeOrg ? {} : { assignedUserId: user.id };
  const tasks = taskRepo.listScoped(orgId, taskFilter);
  return { activeLeads, archivedCount, converted, conversionRate, activities, tasks };
}

const mgrSummary = computeSummary(managerRow);
assert(mgrSummary.activeLeads.length === 3, 'manager (org-wide) sees all 3 active leads, archived excluded');
assert(mgrSummary.archivedCount === 1, 'manager sees the 1 archived lead counted separately');
assert(mgrSummary.converted === 1, 'manager sees 1 converted lead');
assert(Math.abs(mgrSummary.conversionRate - 33.33) < 0.1, 'manager conversion rate ~33.3%');
assert(mgrSummary.activities.length === 3, 'manager sees all 3 org activities');
assert(mgrSummary.tasks.length === 3, 'manager sees all 3 org tasks');

const agentASummary = computeSummary(agentARow);
assert(agentASummary.activeLeads.length === 2, 'agent A (own-scoped) sees only their own 2 active leads');
assert(agentASummary.converted === 1, 'agent A sees their own 1 converted lead');
assert(agentASummary.activities.length === 2, 'agent A sees only their own 2 activities (not agent B\'s)');
assert(agentASummary.tasks.length === 2, 'agent A sees only their own 2 tasks (not agent B\'s)');

// =====================================================================
// 2. SEARCH — replicates routes/search.js exactly
// =====================================================================
console.log('2. GET /search?q=');
function runSearch(user, q) {
  const orgId = user.organisation_id;
  const canSeeOrg = hasPermission(user.role_id, 'data.view.org');
  const leadFilter = canSeeOrg ? {} : { ownerUserId: user.id };
  const leads = leadRepo.listScoped(orgId, leadFilter).filter(l => l.company.toLowerCase().includes(q.toLowerCase()));
  const contacts = contactRepo.listByOrganisation(orgId).filter(c => (c.name || '').toLowerCase().includes(q.toLowerCase()));
  return { leads, contacts };
}
const mgrSearch = runSearch(managerRow, 'acme');
assert(mgrSearch.leads.length === 2, 'org-wide search for "acme" finds both Acme leads, not the other org\'s decoy');
assert(mgrSearch.contacts.length === 1, 'org-wide search for "acme" finds Jane Acme, not the other org\'s decoy contact');
const agentBSearch = runSearch(agentBRow, 'acme');
assert(agentBSearch.leads.length === 0, 'own-scoped search for "acme" finds nothing — agent B owns none of the Acme leads');

// =====================================================================
// 3. TASK LIST — replicates routes/activities.js GET /tasks exactly
// =====================================================================
console.log('3. GET /tasks');
function listTasks(user, { status, overdue } = {}) {
  const canSeeOrg = hasPermission(user.role_id, 'data.view.org');
  let rows = canSeeOrg
    ? taskRepo.listScoped(user.organisation_id)
    : taskRepo.listScoped(user.organisation_id, { assignedUserId: user.id });
  if (status) rows = rows.filter(t => t.status === status);
  if (overdue) {
    const today = new Date().toISOString().slice(0, 10);
    rows = rows.filter(t => t.status === 'open' && t.due_date && t.due_date < today);
  }
  return rows;
}
assert(listTasks(managerRow).length === 3, 'manager sees all 3 org tasks unfiltered');
assert(listTasks(agentARow).length === 2, 'agent A sees only their own 2 tasks');
assert(listTasks(managerRow, { status: 'done' }).length === 1, 'status=done filter returns exactly the 1 completed task');
assert(listTasks(managerRow, { overdue: true }).length === 1, 'overdue=true returns exactly the 1 open task with a past due date');
assert(taskOpenPast.status === 'open', 'sanity: overdue fixture task is genuinely still open');

// =====================================================================
// 4. CONTACT ACTIVITIES — replicates routes/activities.js GET /contacts/:id/activities
// =====================================================================
console.log('4. GET /contacts/:id/activities');
function listContactActivities(user, contactId) {
  const contact = contactRepo.getByIdScoped(contactId, user.organisation_id);
  if (!contact) return null;
  const canSeeOrg = hasPermission(user.role_id, 'data.view.org');
  const filter = canSeeOrg ? { contactId } : { contactId, userId: user.id };
  return activityRepo.listScoped(user.organisation_id, filter);
}
const contactActs = listContactActivities(managerRow, contactA.id);
assert(contactActs.length === 1, 'contact activities returns exactly the 1 activity logged against that contact');
assert(contactActs[0].contact_id === contactA.id, 'returned activity actually belongs to the requested contact');
const crossOrgContactActs = listContactActivities(otherOrgUser, contactA.id);
assert(crossOrgContactActs === null, 'a contact from another organisation is not found (404 path) — isolation holds');

console.log('\nALL CHECKS PASSED');
console.log('\nNOTE: HTTP-level integration_test.js still cannot run in this sandbox (no npm/express network access) — same honest gap as previous passes.');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });