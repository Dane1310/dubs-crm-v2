const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission } = require('../permissions');
const contactRepo = require('../repositories/contactRepository');
const activityRepo = require('../repositories/activityRepository');
const auditRepo = require('../repositories/auditRepository');

router.use(requireAuth);

// Contacts have no owner_user_id in the schema (db.js) — they're a shared,
// organisation-wide address book, not per-agent data. So there is no
// own-vs-org visibility split here the way there is for leads/activities/
// tasks: any authenticated member of the organisation with data.view.own
// (which every role has by default) can list/view contacts.
router.get('/contacts', requirePermission('data.view.own'), (req, res) => {
  res.json(contactRepo.listByOrganisation(req.user.organisation_id));
});

router.get('/contacts/:id', requirePermission('data.view.own'), (req, res) => {
  const contact = contactRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
});

router.post('/contacts', requirePermission('contact.create'), (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name && !email && !phone) {
    return res.status(400).json({ error: 'At least one of name, email, phone is required' });
  }
  const contact = contactRepo.createContact({ organisationId: req.user.organisation_id, name, email, phone });
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'contact.created', entityType: 'contact', entityId: contact.id });
  res.status(201).json(contact);
});

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

// Read side of "this contact's activity history" — same shape as the
// lead-scoped activity listing already used elsewhere (routes/activities.js).
router.get('/contacts/:id/activities', requirePermission('data.view.own'), (req, res) => {
  const contact = contactRepo.getByIdScoped(req.params.id, req.user.organisation_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(activityRepo.listScoped(req.user.organisation_id, { contactId: req.params.id }));
});

module.exports = router;
