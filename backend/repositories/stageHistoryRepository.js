const db = require('../db');
const crypto = require('crypto');

// Records one row every time a lead's stage actually changes. Written from
// leadRepository.updateScoped() itself (not from the route layer) so that
// every caller of updateScoped gets history for free, with no risk of a
// route forgetting to call it separately.
function recordChange({ organisationId, leadId, previousStage, newStage, changedByUserId }) {
  const id = 'stgh_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stage_history (id, organisation_id, lead_id, previous_stage, new_stage, changed_by_user_id, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, organisationId, leadId, previousStage || null, newStage, changedByUserId || null, now);
  return { id, organisationId, leadId, previousStage, newStage, changedByUserId, changedAt: now };
}

function listForLeadScoped(leadId, organisationId) {
  return db.prepare(
    `SELECT * FROM stage_history WHERE lead_id = ? AND organisation_id = ? ORDER BY changed_at ASC`
  ).all(leadId, organisationId);
}

module.exports = { recordChange, listForLeadScoped };