const db = require('../db');
const crypto = require('crypto');

function createTask(data) {
  const id = 'task_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (
      id, organisation_id, lead_id, contact_id, assigned_user_id, due_date,
      priority, status, originating_activity_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.organisationId, data.leadId || null, data.contactId || null,
    data.assignedUserId, data.dueDate || null, data.priority || 'medium',
    'open', data.originatingActivityId || null, now, now
  );
  return getByIdScoped(id, data.organisationId);
}

function getByIdScoped(id, organisationId) {
  return db.prepare(`SELECT * FROM tasks WHERE id = ? AND organisation_id = ?`).get(id, organisationId) || null;
}

function listScoped(organisationId, { assignedUserId = null, leadId = null } = {}) {
  if (leadId) {
    // Lead-scoped listing — the read side of task.create for a given lead
    // (previously only creatable, never listable back; a real frontend
    // needs to show a lead's existing tasks, not just ones made this session).
    return db.prepare(`SELECT * FROM tasks WHERE organisation_id = ? AND lead_id = ? ORDER BY due_date ASC`).all(organisationId, leadId);
  }
  if (assignedUserId) {
    return db.prepare(`SELECT * FROM tasks WHERE organisation_id = ? AND assigned_user_id = ? ORDER BY due_date ASC`).all(organisationId, assignedUserId);
  }
  return db.prepare(`SELECT * FROM tasks WHERE organisation_id = ? ORDER BY due_date ASC`).all(organisationId);
}

function updateScoped(id, organisationId, patch) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  const allowed = ['due_date','priority','status','assigned_user_id'];
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
  values.push(id, organisationId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND organisation_id = ?`).run(...values);
  return getByIdScoped(id, organisationId);
}

function completeScoped(id, organisationId, completedByUserId) {
  const existing = getByIdScoped(id, organisationId);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ? AND organisation_id = ?`
  ).run(now, completedByUserId, now, id, organisationId);
  return getByIdScoped(id, organisationId);
}

module.exports = { createTask, getByIdScoped, listScoped, updateScoped, completeScoped };