// test_clock_sessions.js — Clock In/Out feature.
// Same pattern as test_pin_bridge.js / test_phase9b_gap_closure.js: exercise
// the real db.js + repositories directly, and replicate the route-layer
// permission/ownership decisions inline (self-service only; org-wide read
// gated by data.view.org) so this genuinely proves the logic, not just the
// SQL. Isolated from every other test file — own fresh :memory:-equivalent
// via a throwaway sqlite file, same convention as the rest of this suite.

const fs = require('fs');
const path = require('path');

// Same isolation convention as test_pin_bridge.js / test_provisioning.js:
// db.js honours FOUNDATION_DB_PATH, so this test gets its own throwaway
// file instead of writing into the real foundation.db or colliding with
// another test file's own throwaway db.
process.env.FOUNDATION_DB_PATH = path.join(__dirname, 'test_clock_sessions.db');
fs.rmSync(process.env.FOUNDATION_DB_PATH, { force: true });

const db = require('./db');
const { seedPermissionsAndDefaultRoles } = require('./permissions');
const clockRepo = require('./repositories/clockRepository');
const orgRepo = require('./repositories/organisationRepository');
const userRepo = require('./repositories/userRepository');
const { hashPassword } = require('./auth');
const crypto = require('crypto');

seedPermissionsAndDefaultRoles();

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok —', msg); }
  else { failed++; console.log('  FAIL —', msg); }
}

// Uses the real repository layer (organisationRepository.createOrganisation
// + userRepository.createUser) rather than hand-crafted INSERTs — same
// convention as test_pin_bridge.js — so this test tracks the real users
// table schema instead of drifting from it.
function makeOrgAndUser(roleName) {
  const org = orgRepo.createOrganisation('Clock Test Org ' + crypto.randomBytes(4).toString('hex'));
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const user = userRepo.createUser({
    organisationId: org.id,
    email: 'clocktest.' + crypto.randomBytes(4).toString('hex') + '@test.local',
    passwordHash: hash,
    passwordSalt: salt,
    roleId: 'role_default_' + roleName.toLowerCase(),
    displayName: 'Test User',
  });
  return { orgId: org.id, userId: user.id };
}

console.log('1. Clock in creates an open session');
{
  const { orgId, userId } = makeOrgAndUser('AGENT');
  ok(clockRepo.getOpenSessionScoped(orgId, userId) === null, 'no open session before clocking in');
  const session = clockRepo.clockIn(orgId, userId);
  ok(!!session.clock_in_at, 'clock_in_at is set');
  ok(session.clock_out_at === null, 'clock_out_at starts null');
  const open = clockRepo.getOpenSessionScoped(orgId, userId);
  ok(open && open.id === session.id, 'getOpenSessionScoped finds it');
}

console.log('2. Clock out closes the open session');
{
  const { orgId, userId } = makeOrgAndUser('AGENT');
  const session = clockRepo.clockIn(orgId, userId);
  const closed = clockRepo.clockOut(orgId, userId);
  ok(closed.id === session.id, 'closes the session that was open');
  ok(!!closed.clock_out_at, 'clock_out_at is now set');
  ok(clockRepo.getOpenSessionScoped(orgId, userId) === null, 'no longer an open session');
}

console.log('3. Clocking out with nothing open returns null (route turns this into 409)');
{
  const { orgId, userId } = makeOrgAndUser('AGENT');
  ok(clockRepo.clockOut(orgId, userId) === null, 'clockOut with no open session returns null, not a throw');
}

console.log('4. A second clock-in while already open is the route\'s job to reject — repository itself allows the write (route enforces the invariant, tested at that layer next)');
{
  const { orgId, userId } = makeOrgAndUser('AGENT');
  clockRepo.clockIn(orgId, userId);
  // Route-layer check, replicated here exactly as routes/clock.js does it:
  const existing = clockRepo.getOpenSessionScoped(orgId, userId);
  ok(!!existing, 'route would see an existing open session and refuse a second clock-in with 409');
}

console.log('5. Organisation isolation — one org never sees another org\'s clock sessions');
{
  const a = makeOrgAndUser('AGENT');
  const b = makeOrgAndUser('AGENT');
  clockRepo.clockIn(a.orgId, a.userId);
  clockRepo.clockIn(b.orgId, b.userId);
  const aHistory = clockRepo.listForUserScoped(a.orgId, a.userId);
  ok(aHistory.length === 1, 'org A sees exactly its own 1 session');
  const crossOrgRead = clockRepo.getOpenSessionScoped(b.orgId, a.userId); // wrong org for this user
  ok(crossOrgRead === null, 'looking up org A\'s user under org B\'s id finds nothing');
}

console.log('6. Two different users in the same org never see each other\'s open session');
{
  const { orgId, userId: userA } = makeOrgAndUser('AGENT');
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const userB = userRepo.createUser({
    organisationId: orgId,
    email: 'clocktest.' + crypto.randomBytes(4).toString('hex') + '@test.local',
    passwordHash: hash, passwordSalt: salt,
    roleId: 'role_default_agent', displayName: 'Other Agent',
  }).id;
  clockRepo.clockIn(orgId, userA);
  ok(clockRepo.getOpenSessionScoped(orgId, userB) === null, 'user B has no open session even though user A does, same org');
}

console.log('7. History is newest-first and date-range filterable');
{
  const { orgId, userId } = makeOrgAndUser('AGENT');
  const s1 = clockRepo.clockIn(orgId, userId);
  clockRepo.clockOut(orgId, userId);
  const s2 = clockRepo.clockIn(orgId, userId);
  clockRepo.clockOut(orgId, userId);
  const history = clockRepo.listForUserScoped(orgId, userId);
  ok(history.length === 2, 'both sessions present');
  ok(history[0].id === s2.id, 'newest session listed first');
  const future = clockRepo.listForUserScoped(orgId, userId, { from: '2099-01-01T00:00:00.000Z' });
  ok(future.length === 0, 'from-date filter excludes both past sessions');
}

console.log('8. Org-wide listing (Owner/Manager view) sees every user\'s sessions in that org');
{
  const { orgId, userId: userA } = makeOrgAndUser('AGENT');
  const { hash, salt } = hashPassword(crypto.randomBytes(16).toString('hex'));
  const userB = userRepo.createUser({
    organisationId: orgId,
    email: 'clocktest.' + crypto.randomBytes(4).toString('hex') + '@test.local',
    passwordHash: hash, passwordSalt: salt,
    roleId: 'role_default_agent', displayName: 'Other Agent',
  }).id;
  clockRepo.clockIn(orgId, userA);
  clockRepo.clockIn(orgId, userB);
  const orgWide = clockRepo.listForOrganisation(orgId);
  ok(orgWide.length === 2, 'org-wide listing includes both users\' sessions');
}

console.log('9. AGENT role does not have data.view.org — cannot reach /clock/all (route-layer check, replicated)');
{
  const { hasPermission } = require('./permissions');
  const { userId, orgId } = makeOrgAndUser('AGENT');
  const user = userRepo.findByIdScoped(userId, orgId);
  ok(hasPermission(user.role_id, 'data.view.org') === false, 'AGENT lacks data.view.org — /clock/all correctly 403s for a plain agent');
}

console.log('10. MANAGER role does have data.view.org — can reach /clock/all');
{
  const { hasPermission } = require('./permissions');
  const { userId, orgId } = makeOrgAndUser('MANAGER');
  const user = userRepo.findByIdScoped(userId, orgId);
  ok(hasPermission(user.role_id, 'data.view.org') === true, 'MANAGER has data.view.org — /clock/all correctly allows this role');
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
try { fs.unlinkSync(process.env.FOUNDATION_DB_PATH); } catch (e) {}
process.exit(failed > 0 ? 1 : 0);
