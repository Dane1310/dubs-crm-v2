// Verifies the smallest genuine gap identified for Leaderboard weighting
// readiness: `reason` and `sentiment` now round-trip through the backend
// exactly like every other legacy log[] field already did.
process.env.FOUNDATION_DB_PATH = require('path').join(__dirname, 'test_phase9.db');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });

require('./permissions').seedPermissionsAndDefaultRoles();
const orgRepo = require('./repositories/organisationRepository');
const userRepo = require('./repositories/userRepository');
const leadRepo = require('./repositories/leadRepository');
const activityRepo = require('./repositories/activityRepository');
const { hashPassword } = require('./auth');

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok — ' + msg); }

const org = orgRepo.createOrganisation('Phase 9 Test Org');
const { hash, salt } = hashPassword('testpassword123');
const user = userRepo.createUser({ organisationId: org.id, email: 'agent@test.com', passwordHash: hash, passwordSalt: salt, roleId: 'role_default_agent' });
const lead = leadRepo.createLead({ organisationId: org.id, company: 'Acme Co', source: 'CIPC Sourced', stage: 'Contacted' });

console.log('1. Create activity with reason + sentiment (fields that did not exist before this change)');
const activity = activityRepo.createActivity({
  organisationId: org.id, leadId: lead.id, userId: user.id,
  channel: 'call', outcome: 'Not interested', reason: 'Budget cut', sentiment: 'detractor', notes: 'Long substantive note about the call outcome and next steps'
});
assert(activity.reason === 'Budget cut', 'reason persisted on create');
assert(activity.sentiment === 'detractor', 'sentiment persisted on create');

console.log('2. Read back scoped by organisation (isolation still holds)');
const fetched = activityRepo.getByIdScoped(activity.id, org.id);
assert(fetched.reason === 'Budget cut', 'reason survives a scoped re-read');
assert(fetched.sentiment === 'detractor', 'sentiment survives a scoped re-read');

console.log('3. Cross-org read returns nothing (isolation)');
const otherOrg = orgRepo.createOrganisation('Other Org');
const crossOrgRead = activityRepo.getByIdScoped(activity.id, otherOrg.id);
assert(crossOrgRead === null, 'activity is not visible to a different organisation_id');

console.log('4. Update reason/sentiment via patch (same path PUT /activities/:id uses)');
const updated = activityRepo.updateScoped(activity.id, org.id, { sentiment: 'promoter', reason: null });
assert(updated.sentiment === 'promoter', 'sentiment updated');
assert(updated.reason === null, 'reason cleared');

console.log('5. Existing fields untouched by the migration (no destructive change)');
const plain = activityRepo.createActivity({ organisationId: org.id, leadId: lead.id, userId: user.id, channel: 'email', outcome: 'Interested', notes: 'ok' });
assert(plain.channel === 'email' && plain.outcome === 'Interested', 'pre-existing fields still work with reason/sentiment omitted');
assert(plain.reason === null && plain.sentiment === null, 'reason/sentiment default to null when not supplied, matching optional legacy fields');

console.log('\nALL CHECKS PASSED');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });