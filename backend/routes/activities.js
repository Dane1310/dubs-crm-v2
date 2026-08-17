const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, hasPermission } = require('../permissions');
const activityRepo = require('../repositories/activityRepository');
const taskRepo = require('../repositories/taskRepository');
const leadRepo = require('../repositories/leadRepository');
const contactRepo = require('../repositories/contactRepository');
const auditRepo = require('../repositories/auditRepository');

router.use(requireAuth);

const ALLOWED_CHANNELS = ['call', 'email', 'whatsapp', 'meeting', 'note', 'other'];
// Matches the legacy client's sentiment select (promoter/passive/detractor)
// so the future backend-driven NPS calc reads the same vocabulary the
// current LEADS[].log[] entries already use — free text, not enforced
// vocabulary for `reason`, same as the legacy client never constrained it.
const ALLOWED_SENTIMENTS = ['promoter', 'passive', 'detractor'];

// --- ACTIVITIES ---

router.post('/activities', requirePermission('activity.create'), (req, res) => {
  const { leadId, contactId, channel, direction, outcome, notes, durationSeconds, occurredAt, reason, sentiment } = req.body || {};
  if (!channel || !ALLOWED_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `channel is required and must be one of: ${ALLOWED_CHANNELS.join(', ')}` });
  }
  if (sentiment !== undefined && sentiment !== null && sentiment !== '' && !ALLOWED_SENTIMENTS.includes(sentiment)) {
    return res.status(400).json({ error: `sentiment must be one of: ${ALLOWED_SENTIMENTS.join(', ')}` });
  }
  if (leadId) {
    const lead = leadRepo.getByIdScoped(leadId, req.user.organisation_id);
    if (!lead) return res.status(400).json({ error: 'leadId does not refer to a lead in your organisation' });
  }
  const activity = activityRepo.createActivity({
    organisationId: req.user.organisation_id, // always from session
    leadId, contactId, userId: req.user.id, channel, direction, outcome, notes, durationSeconds, occurredAt, reason, sentiment
  });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'activity.created', entityType: 'activity', entityId: activity.id });
  res.status(201).json(activity);
});

router.get('/activities/:id', requirePermission('data.view.own'), (req, res) => {
  const activity = activityRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!activity) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && activity.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your activity' });
  }
  res.json(activity);
});

// List activities for a specific lead — the natural read-side of
// activity.create, needed once a frontend actually renders lead history.
router.get('/leads/:leadId/activities', requirePermission('data.view.own'), (req, res) => {
  const lead = leadRepo.getByIdScoped(req.params.leadId, req.user.organisation_id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && lead.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your lead' });
  }
  res.json(activityRepo.listScoped(req.user.organisation_id, { leadId: req.params.leadId }));
});

// List activities for a specific contact — mirrors GET /leads/:leadId/activities.
// Contacts are org-wide to anyone with data.view.own (same visibility as
// GET /contacts/:id itself), but an own-scoped caller still only sees
// activities THEY logged against that contact, same restriction pattern
// as everywhere else own-vs-org splits.
router.get('/contacts/:id/activities', requirePermission('data.view.own'), (req, res) => {
  const contact = contactRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  const filter = canSeeOrg
    ? { contactId: req.params.id }
    : { contactId: req.params.id, userId: req.user.id };
  res.json(activityRepo.listScoped(req.user.organisation_id, filter));
});

router.put('/activities/:id', requirePermission('activity.edit'), (req, res) => {
  const existing = activityRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only edit your own activities' });
  }
  if (req.body.sentiment !== undefined && req.body.sentiment !== null && req.body.sentiment !== '' && !ALLOWED_SENTIMENTS.includes(req.body.sentiment)) {
    return res.status(400).json({ error: `sentiment must be one of: ${ALLOWED_SENTIMENTS.join(', ')}` });
  }
  const patch = {};
  for (const key of ['channel','direction','outcome','notes','reason','sentiment']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (req.body.durationSeconds !== undefined) patch.duration_seconds = req.body.durationSeconds;
  const updated = activityRepo.updateScoped(req.params.id, req.user.organisation_id, patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'activity.updated', entityType: 'activity', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

// --- TASKS ---

router.post('/tasks', requirePermission('task.create'), (req, res) => {
  const { leadId, contactId, assignedUserId, dueDate, priority, originatingActivityId } = req.body || {};
  const patch = {
    organisationId: req.user.organisation_id, // always from session
    leadId, contactId,
    assignedUserId: assignedUserId || req.user.id, // defaults to self-assign
    dueDate, priority, originatingActivityId
  };
  const task = taskRepo.createTask(patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.created', entityType: 'task', entityId: task.id });
  res.status(201).json(task);
});

// LIST tasks (dashboard) — own-vs-org scoping decided server-side exactly
// like GET /leads, never from a client-supplied assignedUserId. status and
// overdue are optional query filters the frontend Tasks Dashboard applies
// (?status=open, ?overdue=true); applied in-memory over the already-scoped
// rows rather than a new SQL path, since the row counts here are small.
router.get('/tasks', requirePermission('data.view.own'), (req, res) => {
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  let rows = canSeeOrg
    ? taskRepo.listScoped(req.user.organisation_id)
    : taskRepo.listScoped(req.user.organisation_id, { assignedUserId: req.user.id });

  const { status, overdue } = req.query;
  if (status) rows = rows.filter(t => t.status === status);
  if (overdue === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    rows = rows.filter(t => t.status === 'open' && t.due_date && t.due_date < today);
  }
  res.json(rows);
});

router.get('/tasks/:id', requirePermission('data.view.own'), (req, res) => {
  const task = taskRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && task.assigned_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your task' });
  }
  res.json(task);
});

router.put('/tasks/:id', requirePermission('task.edit'), (req, res) => {
  const existing = taskRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.assigned_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only edit your own tasks' });
  }
  const patch = {};
  for (const key of ['dueDate','priority','status','assignedUserId']) {
    if (req.body[key] !== undefined) patch[{dueDate:'due_date',assignedUserId:'assigned_user_id'}[key] || key] = req.body[key];
  }
  const updated = taskRepo.updateScoped(req.params.id, req.user.organisation_id, patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.updated', entityType: 'task', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

router.post('/tasks/:id/complete', requirePermission('task.edit'), (req, res) => {
  const existing = taskRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.assigned_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only complete your own tasks' });
  }
  const updated = taskRepo.completeScoped(req.params.id, req.user.organisation_id, req.user.id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'task.completed', entityType: 'task', entityId: req.params.id });
  res.json(updated);
});

module.exports = router;