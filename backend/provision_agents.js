// provision_agents.js
//
// One-time, OWNER-run bridge between the existing floor-agent roster
// (ACTIVE_AGENTS / ROLES from the frontend's "Download full backup") and
// real backend users. This is identity provisioning ONLY:
//   - does not touch activity logging, the Leaderboard, or weighting
//   - does not change the PIN floor workflow
//   - never gives an agent backend login credentials — the users this
//     creates are attribution records (status 'provisioned'), not accounts
//     anyone signs into
//
// Input is the JSON produced by the "Download full backup" button in the
// Owner Settings panel (it already includes activeAgents + roles, and
// deliberately excludes PINs). Re-running is safe: existing matches are
// left alone, nothing is re-created or duplicated.
//
// Usage: node provision_agents.js <path-to-backup.json> <organisationId>
//
// Role mapping is deliberately conservative: only 'agent' and 'manager'
// (the two frontend role strings with an unambiguous backend equivalent)
// are auto-created. 'ceo' and anything unrecognized is FLAGGED, not
// auto-mapped — collapsing it onto backend OWNER would silently grant
// users.manage/config.manage/owner.restricted to whoever holds that floor
// label, which is a permissions decision, not an identity one.

const fs = require('fs');
const db = require('./db');
const userRepo = require('./repositories/userRepository');
const leadRepo = require('./repositories/leadRepository');
const auditRepo = require('./repositories/auditRepository');

const ROLE_MAP = {
  agent: 'role_default_agent',
  manager: 'role_default_manager',
};

function provision(filePath, organisationId) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const backup = JSON.parse(raw);

  const activeAgents = Array.isArray(backup.activeAgents) ? backup.activeAgents : [];
  const roles = backup.roles && typeof backup.roles === 'object' ? backup.roles : {};

  const report = {
    sourceCount: activeAgents.length,
    alreadyMapped: [],   // roster name already had a matching backend user
    created: [],         // new provisioned user created
    flagged: [],         // needs manual decision — nothing created
    leadsBackfilled: 0,  // owner_name_raw -> owner_user_id rows updated
  };

  const startedAt = new Date().toISOString();

  for (const rawName of activeAgents) {
    const name = (rawName || '').trim();
    if (!name) {
      report.flagged.push({ name: rawName, reason: 'blank/unusable roster name' });
      continue;
    }

    const existing = userRepo.findByDisplayNameScoped(organisationId, name);
    let userId;

    if (existing) {
      report.alreadyMapped.push({ name, userId: existing.id, status: existing.status });
      userId = existing.id;
    } else {
      const roleKey = (roles[rawName] || roles[name] || 'agent').toLowerCase();
      const roleId = ROLE_MAP[roleKey];
      if (!roleId) {
        report.flagged.push({
          name,
          reason: `role "${roleKey}" has no unambiguous backend mapping — decide manually (does this map to MANAGER, or a real OWNER account, or something else?)`,
        });
        continue;
      }
      const created = userRepo.createProvisionedUser({ organisationId, displayName: name, roleId });
      report.created.push({ name, userId: created.id, role: roleKey });
      userId = created.id;
    }

    // Retroactive attribution: close the gap migrate_leads.js left open
    // (owner_user_id: null, owner_name_raw: the legacy agent name) for any
    // lead whose raw name now cleanly matches this user.
    const changed = leadRepo.backfillOwnerFromNameScoped(organisationId, name, userId);
    report.leadsBackfilled += changed;
  }

  auditRepo.record({
    organisationId,
    userId: null,
    event: 'agents.provisioned',
    entityType: 'roster_provisioning_run',
    entityId: null,
    metadata: { startedAt, finishedAt: new Date().toISOString(), ...report },
  });

  return report;
}

if (require.main === module) {
  const [, , filePath, organisationId] = process.argv;
  if (!filePath || !organisationId) {
    console.error('Usage: node provision_agents.js <path-to-backup.json> <organisationId>');
    process.exit(1);
  }
  const result = provision(filePath, organisationId);
  console.log(JSON.stringify(result, null, 2));
  if (result.flagged.length) {
    console.log(`\n${result.flagged.length} roster name(s) need a manual decision before they can be provisioned — see "flagged" above. Nothing was created for them.`);
  }
}

module.exports = { provision };