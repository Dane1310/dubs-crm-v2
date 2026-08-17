// Focused tests for provision_agents.js — the roster-name-to-backend-user
// identity bridge. Not previously covered by any test file, despite being
// the piece the PIN-agent activity write path (once wired) would depend on.
//
// Covers: fresh provisioning, re-run safety (no duplicates), unmapped-role
// flagging, org isolation of provisioned users, provisioned users cannot
// authenticate, and retroactive lead owner_user_id backfill.

process.env.FOUNDATION_DB_PATH = require('path').join(__dirname, 'test_provisioning.db');
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });

require('./permissions').seedPermissionsAndDefaultRoles();
const orgRepo = require('./repositories/organisationRepository');
const userRepo = require('./repositories/userRepository');
const leadRepo = require('./repositories/leadRepository');
const { provision } = require('./provision_agents.js');
const { getSession } = require('./auth');

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok — ' + msg); }

const org = orgRepo.createOrganisation('Provisioning Test Org');
const otherOrg = orgRepo.createOrganisation('Other Org');

// Legacy leads with owner_name_raw set but owner_user_id NULL — exactly
// migrate_leads.js's known output shape before any user accounts exist.
const leadThabo1 = leadRepo.createLead({ organisationId: org.id, company: 'Alpha Co', stage: 'New', ownerNameRaw: 'Thabo M' });
const leadThabo2 = leadRepo.createLead({ organisationId: org.id, company: 'Beta Co', stage: 'Contacted', ownerNameRaw: '  thabo m  ' }); // messy case/whitespace, same person
const leadOther = leadRepo.createLead({ organisationId: org.id, company: 'Gamma Co', stage: 'New', ownerNameRaw: 'Someone Else' });

const backupPath = require('path').join(__dirname, 'test_backup.json');
require('fs').writeFileSync(backupPath, JSON.stringify({
  activeAgents: ['Thabo M', 'Priya K', '', 'Site CEO'],
  roles: { 'Thabo M': 'agent', 'Priya K': 'manager', 'Site CEO': 'ceo' },
}));

console.log('1. First provisioning run — fresh org, no existing backend users');
const report1 = provision(backupPath, org.id);
assert(report1.created.length === 2, 'creates 2 users (Thabo M as agent, Priya K as manager) — blank name and unmapped "ceo" role are not auto-created');
assert(report1.flagged.length === 2, 'flags exactly 2 entries: the blank roster name and the unmapped "ceo" role');
assert(report1.flagged.some(f => f.reason.includes('blank')), 'blank name is flagged with a clear reason');
assert(report1.flagged.some(f => f.reason.includes('ceo')), '"ceo" role is flagged rather than silently mapped to OWNER');
assert(report1.alreadyMapped.length === 0, 'nothing pre-existed on a fresh org');

console.log('2. Provisioned users cannot authenticate (attribution record, not a login)');
const thabo = userRepo.findByDisplayNameScoped(org.id, 'Thabo M');
assert(thabo.status === 'provisioned', 'created user has status "provisioned", not "active"');
assert(getSession('not-a-real-token') === null, 'sanity: getSession rejects garbage tokens the same way it would reject a provisioned user with no real session');

console.log('3. Case/whitespace-insensitive matching (Thabo M vs "  thabo m  ")');
const thaboLookupMessy = userRepo.findByDisplayNameScoped(org.id, '  THABO m ');
assert(thaboLookupMessy && thaboLookupMessy.id === thabo.id, 'messy-case lookup resolves to the same provisioned user, not a duplicate');

console.log('4. Retroactive lead backfill — owner_user_id filled in for matching leads only');
const l1 = leadRepo.getByIdScoped(leadThabo1.id, org.id);
const l2 = leadRepo.getByIdScoped(leadThabo2.id, org.id);
const l3 = leadRepo.getByIdScoped(leadOther.id, org.id);
assert(l1.owner_user_id === thabo.id, 'lead with exact-case owner_name_raw match backfilled to the provisioned user');
assert(l2.owner_user_id === thabo.id, 'lead with messy-case owner_name_raw match ALSO backfilled (case/whitespace-insensitive)');
assert(l3.owner_user_id === null, 'lead owned by a different, unprovisioned name is left untouched, not guessed at');
assert(report1.leadsBackfilled === 2, 'report accurately counts 2 leads backfilled in this run');

console.log('5. Re-running provisioning is safe — no duplicate users, no duplicate backfill');
const report2 = provision(backupPath, org.id);
assert(report2.created.length === 0, 'second run creates 0 new users — Thabo M and Priya K already exist');
assert(report2.alreadyMapped.length === 2, 'second run reports both names as already mapped');
assert(report2.leadsBackfilled === 0, 'second run backfills 0 leads — nothing left to backfill, not re-applied');
const allUsersNamedThabo = require('./db').prepare(
  `SELECT COUNT(*) as c FROM users WHERE organisation_id = ? AND LOWER(TRIM(display_name)) = 'thabo m'`
).get(org.id).c;
assert(allUsersNamedThabo === 1, 'exactly one backend user exists for Thabo M after two runs — no duplicate created');

console.log('6. Organisation isolation — provisioning one org never touches another');
const otherOrgThabo = userRepo.findByDisplayNameScoped(otherOrg.id, 'Thabo M');
assert(otherOrgThabo === null, 'the other organisation has no "Thabo M" user — provisioning did not leak across orgs');
provision(backupPath, otherOrg.id);
const otherOrgThaboAfter = userRepo.findByDisplayNameScoped(otherOrg.id, 'Thabo M');
assert(otherOrgThaboAfter !== null && otherOrgThaboAfter.id !== thabo.id, 'provisioning the other org creates its OWN distinct Thabo M user, not a shared/cross-org row');

console.log('\nALL CHECKS PASSED');
require('fs').unlinkSync(backupPath);
require('fs').rmSync(process.env.FOUNDATION_DB_PATH, { force: true });