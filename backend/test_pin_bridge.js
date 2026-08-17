// Focused tests for the PIN-agent identity bridge: PUT /users/:id/pin,
// POST /auth/pin-login, and that an activity created with the resulting
// session is attributed to the correct real user_id — the specific gap
// this increment closes. Exercises repository + auth layer directly
// (same reasoning as test_phase9b/test_provisioning: no network egress
// in this sandbox to npm install express for an HTTP-level test).

process.env.FOUNDATION_DB_PATH = require('path').join(__dirname, 'test_pin_bridge.db');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });

require('./permissions').seedPermissionsAndDefaultRoles();
const orgRepo = require('./repositories/organisationRepository');
const userRepo = require('./repositories/userRepository');
const activityRepo = require('./repositories/activityRepository');
const { hashPassword, verifyPassword, createSession, getSession } = require('./auth');
const { provision } = require('./provision_agents.js');

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok — ' + msg); }

const org = orgRepo.createOrganisation('PIN Bridge Test Org');
const otherOrg = orgRepo.createOrganisation('Other Org');

// Provision a floor agent the normal way (roster backup -> provision_agents.js),
// exactly like the real workflow, rather than hand-crafting a user row.
const backupPath = require('path').join(__dirname, 'test_pin_backup.json');
require('fs').writeFileSync(backupPath, JSON.stringify({ activeAgents: ['Nomvula K'], roles: { 'Nomvula K': 'agent' } }));
provision(backupPath, org.id);
const agent = userRepo.findByDisplayNameScoped(org.id, 'Nomvula K');

console.log('1. Provisioned user has no PIN yet — cannot pin-login');
assert(agent.status === 'provisioned', 'sanity: freshly provisioned, not yet active');
assert(!agent.pin_hash, 'sanity: no PIN set yet');
function attemptPinLogin(organisationId, displayName, pin) {
  const user = userRepo.findByDisplayNameScoped(organisationId, displayName);
  if (!user || user.status === 'disabled') return null;
  if (!user.pin_hash || !user.pin_salt) return null;
  if (!verifyPassword(pin, user.pin_salt, user.pin_hash)) return null;
  if (user.status === 'provisioned') userRepo.updateScoped(user.id, organisationId, { status: 'active' });
  return createSession(user.id, organisationId);
}
assert(attemptPinLogin(org.id, 'Nomvula K', '1234') === null, 'pin-login rejected — no PIN has been set for this user yet');

console.log('2. Owner sets a PIN (PUT /users/:id/pin logic)');
const { hash, salt } = hashPassword('7421');
const afterSet = userRepo.setPinScoped(agent.id, org.id, { hash, salt });
assert(afterSet.id === agent.id, 'setPinScoped returns the same user');
const reread = userRepo.findByIdScoped(agent.id, org.id);
assert(reread.pin_hash === hash && reread.pin_salt === salt, 'pin_hash/pin_salt persisted');

console.log('3. Wrong PIN is rejected, correct PIN succeeds and activates the user');
assert(attemptPinLogin(org.id, 'Nomvula K', '0000') === null, 'wrong PIN rejected');
const session = attemptPinLogin(org.id, 'Nomvula K', '7421');
assert(session && session.token, 'correct PIN returns a real session token');
const nowActive = userRepo.findByIdScoped(agent.id, org.id);
assert(nowActive.status === 'active', 'first successful PIN login activates the provisioned user (status flips to active)');

console.log('4. The resulting session resolves to the correct user (what requireAuth would do)');
const resolved = getSession(session.token);
assert(resolved.user_id === agent.id, 'session resolves back to the exact provisioned/now-active user, not anyone else');
assert(resolved.organisation_id === org.id, 'session is scoped to the correct organisation');

console.log('5. An activity created via this session is attributed to the real user_id — not a raw name');
const activity = activityRepo.createActivity({
  organisationId: org.id, userId: resolved.user_id, // exactly what routes/activities.js POST /activities does with req.user.id
  channel: 'call', outcome: 'Interested', notes: 'Logged via PIN-authenticated floor session',
});
assert(activity.user_id === agent.id, 'activity.user_id is the real backend user id');
assert(typeof activity.user_id === 'string' && activity.user_id.startsWith('user_'), 'user_id is a genuine user row id, not a name string');
assert(activity.lead_id === null, 'lead_id correctly left null when no backend lead linkage is available yet (schema allows this)');

console.log('6. Re-running pin-login (e.g. next shift) does not create a duplicate identity or re-activate anything oddly');
const session2 = attemptPinLogin(org.id, 'Nomvula K', '7421');
assert(session2.token !== session.token, 'each login mints its own fresh session token');
const stillOneUser = require('./db').prepare(
  `SELECT COUNT(*) as c FROM users WHERE organisation_id = ? AND LOWER(TRIM(display_name)) = 'nomvula k'`
).get(org.id).c;
assert(stillOneUser === 1, 'still exactly one backend user for Nomvula K after two PIN logins');

console.log('7. Organisation isolation — same display name + PIN in a different org resolves to nobody');
assert(attemptPinLogin(otherOrg.id, 'Nomvula K', '7421') === null, 'PIN login scoped to org — same name/PIN combo does not work cross-org');

console.log('8. A disabled user cannot PIN-login even with the correct PIN');
userRepo.updateScoped(agent.id, org.id, { status: 'disabled' });
assert(attemptPinLogin(org.id, 'Nomvula K', '7421') === null, 'disabled status blocks PIN login exactly like it blocks password login');

console.log('\nALL CHECKS PASSED');
require('fs').unlinkSync(backupPath);
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });