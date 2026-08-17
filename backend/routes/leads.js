const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, hasPermission } = require('../permissions');
const leadRepo = require('../repositories/leadRepository');
const contactRepo = require('../repositories/contactRepository');
const auditRepo = require('../repositories/auditRepository');
const taskRepo = require('../repositories/taskRepository');
const stageHistoryRepo = require('../repositories/stageHistoryRepository');
const userRepo = require('../repositories/userRepository');
const { STAGES, isValidStage } = require('../stages');

router.use(requireAuth);

// LIST leads — scoped by permission level, not by trusting a query param.
router.get('/leads', requirePermission('data.view.own'), (req, res) => {
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  const rows = canSeeOrg
    ? leadRepo.listScoped(req.user.organisation_id)
    : leadRepo.listScoped(req.user.organisation_id, { ownerUserId: req.user.id });
  res.json(rows);
});

// PIPELINE — leads grouped by stage, in canonical stage order, for a
// kanban-style pipeline view. Same visibility rule as GET /leads (own vs
// org scoping) and same archived-exclusion default — this is a regrouping
// of that same list, not a separate data source.
router.get('/pipeline', requirePermission('data.view.own'), (req, res) => {
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  const rows = canSeeOrg
    ? leadRepo.listScoped(req.user.organisation_id)
    : leadRepo.listScoped(req.user.organisation_id, { ownerUserId: req.user.id });

  const byStage = {};
  for (const stage of STAGES) byStage[stage] = [];
  for (const lead of rows) {
    // A lead with a stage outside the canonical list (e.g. legacy/migrated
    // data) is still shown, grouped under its own key, rather than silently
    // dropped from the pipeline.
    if (!byStage[lead.stage]) byStage[lead.stage] = [];
    byStage[lead.stage].push(lead);
  }
  const stages = Object.keys(byStage).map(stage => ({
    stage, count: byStage[stage].length, leads: byStage[stage],
  }));
  res.json({ stages, total: rows.length });
});

// VIEW single lead
router.get('/leads/:id', requirePermission('data.view.own'), (req, res) => {
  const lead = leadRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && lead.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your lead' });
  }
  res.json(lead);
});

// CREATE lead
router.post('/leads', requirePermission('lead.create'), (req, res) => {
  const { company, source, stage, industry, address, website, followUpDate, contactName, contactEmail, contactPhone } = req.body || {};
  if (!company || !company.toString().trim()) {
    return res.status(400).json({ error: 'company is required' });
  }
  if (stage !== undefined && !isValidStage(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
  }
  let contactId = null;
  if (contactName || contactEmail || contactPhone) {
    const contact = contactRepo.createContact({
      organisationId: req.user.organisation_id, name: contactName, email: contactEmail, phone: contactPhone
    });
    contactId = contact.id;
  }
  const lead = leadRepo.createLead({
    organisationId: req.user.organisation_id, // ALWAYS from the session, never from req.body
    contactId, company: company.toString().trim(), source, stage,
    ownerUserId: req.user.id, ownerNameRaw: req.user.email,
    industry, address, website, followUpDate, dateAdded: new Date().toISOString().slice(0,10),
  });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'lead.created', entityType: 'lead', entityId: lead.id });
  res.status(201).json(lead);
});

// UPDATE lead
router.put('/leads/:id', requirePermission('lead.edit'), (req, res) => {
  const existing = leadRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only edit your own leads' });
  }

  // organisation_id is intentionally never accepted from req.body here —
  // updateScoped() only ever writes fields from a fixed allow-list, and the
  // WHERE clause is re-scoped server-side regardless of what was sent.
  if (req.body.stage !== undefined && !isValidStage(req.body.stage)) {
    return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
  }

  const patch = {};
  for (const key of ['company','source','stage','industry','address','website']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (req.body.followUpDate !== undefined) patch.follow_up_date = req.body.followUpDate;

  if (req.body.contactId !== undefined) patch.contact_id = req.body.contactId;

  // OWNERSHIP REASSIGNMENT — a distinct, more sensitive action than editing
  // your own lead's fields, so it's gated on data.view.org regardless of
  // whether the caller happens to own this particular lead (an org-wide
  // editor reassigning FROM someone else's lead is exactly the normal case).
  if (req.body.ownerUserId !== undefined) {
    if (!canEditOrg) {
      return res.status(403).json({ error: 'Forbidden — reassigning lead ownership requires org-wide edit access' });
    }
    const targetUser = userRepo.findByIdScoped(req.body.ownerUserId, req.user.organisation_id);
    if (!targetUser || targetUser.status !== 'active') {
      return res.status(400).json({ error: 'ownerUserId must refer to an active user in your organisation' });
    }
    patch.owner_user_id = targetUser.id;
    patch.owner_name_raw = targetUser.email;
  }

  const updated = leadRepo.updateScoped(req.params.id, req.user.organisation_id, patch, req.user.id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'lead.updated', entityType: 'lead', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

// ARCHIVE / UNARCHIVE — dedicated action endpoints rather than overloading
// PUT with an `archived` field, so this is an explicit, auditable action.
// Archived leads are excluded from the default GET /leads list (see
// listScoped) but remain directly retrievable by id — nothing is deleted.
router.post('/leads/:id/archive', requirePermission('lead.edit'), (req, res) => {
  const existing = leadRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only archive your own leads' });
  }
  const updated = leadRepo.archiveScoped(req.params.id, req.user.organisation_id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'lead.archived', entityType: 'lead', entityId: req.params.id });
  res.json(updated);
});

router.post('/leads/:id/unarchive', requirePermission('lead.edit'), (req, res) => {
  const existing = leadRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canEditOrg && existing.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — you can only unarchive your own leads' });
  }
  const updated = leadRepo.unarchiveScoped(req.params.id, req.user.organisation_id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'lead.unarchived', entityType: 'lead', entityId: req.params.id });
  res.json(updated);
});

// STAGE HISTORY — read side of the stage-change tracking written inside
// leadRepository.updateScoped(). Fixes a real bug: the frontend already
// called this endpoint unconditionally on every lead-detail load; it did
// not exist, so viewing any lead's details failed outright.
router.get('/leads/:id/stage-history', requirePermission('data.view.own'), (req, res) => {
  const lead = leadRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && lead.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your lead' });
  }
  res.json(stageHistoryRepo.listForLeadScoped(req.params.id, req.user.organisation_id));
});

// LIST tasks for a lead — mirrors GET /leads/:leadId/activities exactly.
// Previously the "Backend Sync" tab could only show tasks created in the
// current session; this is the actual persisted list.
router.get('/leads/:leadId/tasks', requirePermission('data.view.own'), (req, res) => {
  const lead = leadRepo.getByIdScoped(req.params.leadId, req.user.organisation_id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  if (!canSeeOrg && lead.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden — not your lead' });
  }
  res.json(taskRepo.listScoped(req.user.organisation_id, { leadId: req.params.leadId }));
});

// LIST contacts
router.get('/contacts', requirePermission('data.view.own'), (req, res) => {
  res.json(contactRepo.listByOrganisation(req.user.organisation_id));
});

// VIEW single contact
router.get('/contacts/:id', requirePermission('data.view.own'), (req, res) => {
  const contact = contactRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
});

// CREATE contact — standalone, or attached to an existing lead via leadId.
// Contacts could previously only be created inline at lead-creation time.
router.post('/contacts', requirePermission('contact.create'), (req, res) => {
  const { name, email, phone, leadId } = req.body || {};
  if (!name && !email && !phone) {
    return res.status(400).json({ error: 'At least one of name, email, or phone is required' });
  }
  let lead = null;
  if (leadId) {
    lead = leadRepo.getByIdScoped(leadId, req.user.organisation_id);
    if (!lead) return res.status(400).json({ error: 'leadId does not refer to a lead in your organisation' });
    const canEditOrg = hasPermission(req.user.role_id, 'data.view.org');
    if (!canEditOrg && lead.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden — you can only attach a contact to your own lead' });
    }
  }
  const contact = contactRepo.createContact({ organisationId: req.user.organisation_id, name, email, phone });
  if (lead) {
    leadRepo.updateScoped(leadId, req.user.organisation_id, { contact_id: contact.id }, req.user.id);
  }
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'contact.created', entityType: 'contact', entityId: contact.id });
  res.status(201).json(contact);
});

// UPDATE contact — contacts previously could never be edited at all.
router.put('/contacts/:id', requirePermission('contact.edit'), (req, res) => {
  const existing = contactRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  for (const key of ['name', 'email', 'phone']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const updated = contactRepo.updateScoped(req.params.id, req.user.organisation_id, patch);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'contact.updated', entityType: 'contact', entityId: req.params.id, metadata: patch });
  res.json(updated);
});

module.exports = router;