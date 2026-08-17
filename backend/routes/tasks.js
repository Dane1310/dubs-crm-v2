const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, hasPermission } = require('../permissions');
const taskRepo = require('../repositories/taskRepository');
const leadRepo = require('../repositories/leadRepository');
const auditRepo = require('../repositories/auditRepository');

router.use(requireAuth);

// LIST tasks — own vs org scoping mirrors GET /leads. Optional ?leadId=
// filters to a single lead's tasks regardless of assignee (still org-scoped).
router.get('/tasks', requirePermission('data.view.own'), (req, res) => {
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (req.query.leadId) {
    const rows = taskRepo.listScoped(req.user.organisation_id, { leadId: req.query.leadId });
    const visible = canSeeOrg ? rows : rows.filter(t => t.assigned_user_id === req.user.id);
    return res.json(visible);
  }
  const rows = canSeeOrg
    ? taskRepo.listScoped(req.user.organisation_id)
    : taskRepo.listScoped(req.user.organisation_id, { assignedUserId: req.user.id });
  res.json(rows);
});

// CREATE task — assignedUserId defaults to the caller if not supplied.
// If org-wide task.create existed as a separate permission from lead.create
// it would gate here; this reuses task.create per the existing catalog.
router.post('/tasks', requirePermission('task.create'), (req, res) => {
  const { leadId, contactId, dueDate, priority, assignedUserId, originatingActivityId } = req.body || {};
  if (leadId) {
    const lead = leadRepo.getByIdScoped(leadId, req.user.organisation_id);
    if (!lead) return res.status(400).json({ error: 'leadId does not exist in your organisation' });
  }
  const task = taskRepo.createTask({
    organisationId: req.user.organisation_id,
    leadId: leadId || null,
    contactId: contactId || null,
    assignedUserId: assignedUserId || req.user.id,
    dueDate: dueDate || null,
    priority: priority || 'medium',
    originatingActivityId: originatingActivityId || null,
  });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.created', entityType: 'task', entityId: task.id });
  res.status(201).json(task);
});

// UPDATE task (due date / priority / status / reassignment) — own task
// always editable by its assignee; org-wide edit requires data.view.org,
// same rule as task.edit's stated meaning in permissions.js.
router.put('/tasks/:id', requirePermission('task.edit'), (req, res) => {
  const existing = taskRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && existing.assigned_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your task' });
  }
  const patch = {};
  for (const key of ['due_date', 'priority', 'status', 'assigned_user_id']) {
    const bodyKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (req.body[bodyKey] !== undefined) patch[key] = req.body[bodyKey];
  }
  const updated = taskRepo.updateScoped(req.params.id, req.user.organisation_id, patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.updated', entityType: 'task', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

// COMPLETE task — separate from generic update so "who actually completed
// it" (completed_by) is always the authenticated caller, never client-supplied.
router.put('/tasks/:id/complete', requirePermission('task.edit'), (req, res) => {
  const existing = taskRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && existing.assigned_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your task' });
  }
  const updated = taskRepo.completeScoped(req.params.id, req.user.organisation_id, req.user.id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.completed', entityType: 'task', entityId: req.params.id });
  res.json(updated);
});

module.exports = router;
