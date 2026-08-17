const db = require('../db');
const crypto = require('crypto');
const stageHistoryRepo = require('./stageHistoryRepository');

function createLead(data) {
  const id = 'lead_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO leads (
      id, organisation_id, contact_id, legacy_id, company, source, stage,
      owner_user_id, owner_name_raw, industry, address, website,
      follow_up_date, date_added, duplicate_flag, duplicate_of_lead_id,
      archived, raw_extra, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.organisationId, data.contactId || null, data.legacyId || null, data.company,
    data.source || null, data.stage || 'New', data.ownerUserId || null, data.ownerNameRaw || null,
    data.industry || null, data.address || null, data.website || null, data.followUpDate || null,
    data.dateAdded || null, data.duplicateFlag ? 1 : 0, data.duplicateOfLeadId || null,
    data.archived ? 1 : 0, data.rawExtra ? JSON.stringify(data.rawExtra) : null, now, now
  );
  return { id, ...data };
}

// Every read method below REQUIRES organisationId and filters by it in the
// SQL itself — this is the structural enforcement point (Phase 2 §C),
// not a convention callers have to remember.

function findByLegacyId(organisationId, legacyId) {
  return db.prepare(`SELECT * FROM leads WHERE organisation_id = ? AND legacy_id = ?`).get(organisationId, legacyId) || null;
}

function findDuplicateByCompany(organisationId, company) {
  return db.prepare(
    `SELECT * FROM leads WHERE organisation_id = ? AND LOWER(TRIM(company)) = LOWER(TRIM(?)) AND archived = 0`
  ).get(organisationId, company) || null;
}

function listScoped(organisationId, { ownerUserId = null, includeArchived = false } = {}) {
  // ownerUserId set = "own" scoping (data.view.own); null = full org visibility (data.view.org)
  // includeArchived: default listings hide archived leads (they still exist,
  // still reachable directly via getByIdScoped) — same rule regardless of
  // own-vs-org scoping, so it's one shared WHERE fragment, not duplicated.
  const archivedClause = includeArchived ? '' : ' AND archived = 0';
  if (ownerUserId) {
    return db.prepare(`SELECT * FROM leads WHERE organisation_id = ? AND owner_user_id = ?${archivedClause}`).all(organisationId, ownerUserId);
  }
  return db.prepare(`SELECT * FROM leads WHERE organisation_id = ?${archivedClause}`).all(organisationId);
}

function getByIdScoped(id, organisationId) {
  // Will not return a row even if the ID exists, if it belongs to a
  // different organisation — this is what test H2 in the Phase 4 report
  // verifies directly.
  return db.prepare(`SELECT * FROM leads WHERE id = ? AND organisation_id = ?`).get(id, organisationId) || null;
}

function updateScoped(id, organisationId, patch, actorUserId = null) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  // contact_id added here (Phase 6): lets an existing lead with no contact
  // get one attached later, through the same scoped/allow-listed patch
  // mechanism as every other field — no separate "attach contact" endpoint.
  const allowed = ['company','source','stage','industry','address','website','follow_up_date','owner_user_id','owner_name_raw','contact_id'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id, organisationId); // WHERE clause — organisation_id repeated here on purpose,
                                    // so even a crafted request can't move/edit another org's row.
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ? AND organisation_id = ?`).run(...values);

  // Record stage history only when `stage` was actually part of this patch
  // AND it's a genuine change — not on every update, and not a no-op
  // "set it to what it already was" call.
  if (Object.prototype.hasOwnProperty.call(patch, 'stage') && patch.stage !== existing.stage) {
    stageHistoryRepo.recordChange({
      organisationId, leadId: id,
      previousStage: existing.stage, newStage: patch.stage,
      changedByUserId: actorUserId,
    });
  }

  return getByIdScoped(id, organisationId);
}

function archiveScoped(id, organisationId) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  db.prepare(`UPDATE leads SET archived = 1, updated_at = ? WHERE id = ? AND organisation_id = ?`)
    .run(new Date().toISOString(), id, organisationId);
  return getByIdScoped(id, organisationId);
}

function unarchiveScoped(id, organisationId) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  db.prepare(`UPDATE leads SET archived = 0, updated_at = ? WHERE id = ? AND organisation_id = ?`)
    .run(new Date().toISOString(), id, organisationId);
  return getByIdScoped(id, organisationId);
}

function countByOrganisation(organisationId) {
  return db.prepare(`SELECT COUNT(*) as c FROM leads WHERE organisation_id = ?`).get(organisationId).c;
}

// Retroactive attribution only — migrate_leads.js left owner_user_id NULL
// for every legacy lead (report section I) because no user accounts
// existed at the time. This closes that specific gap once
// provision_agents.js has created/matched a user: only touches rows where
// owner_name_raw cleanly matches (case/whitespace-insensitive) and
// owner_user_id is still unset. Never overwrites an existing owner_user_id.
function backfillOwnerFromNameScoped(organisationId, ownerNameRaw, ownerUserId) {
  const result = db.prepare(
    `UPDATE leads SET owner_user_id = ?, updated_at = ?
     WHERE organisation_id = ? AND owner_user_id IS NULL
       AND LOWER(TRIM(owner_name_raw)) = LOWER(TRIM(?))`
  ).run(ownerUserId, new Date().toISOString(), organisationId, ownerNameRaw);
  return result.changes;
}

module.exports = {
  createLead, findByLegacyId, findDuplicateByCompany, listScoped,
  getByIdScoped, updateScoped, archiveScoped, unarchiveScoped, countByOrganisation,
  backfillOwnerFromNameScoped
};