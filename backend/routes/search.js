const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, hasPermission } = require('../permissions');
const leadRepo = require('../repositories/leadRepository');
const contactRepo = require('../repositories/contactRepository');

router.use(requireAuth);

const MAX_RESULTS = 20;

// GET /search?q= — searches only entities already reachable through the
// existing repositories (leads, contacts), scoped exactly like their own
// list endpoints: own-vs-org for leads (same rule as GET /leads), org-wide
// for contacts (same rule as GET /contacts, matched by the frontend's own
// comment that "contacts are org-wide to anyone with data.view.own"). No
// raw SQL, no admin/cross-org access — this re-filters the same rows those
// endpoints would already return.
router.get('/search', requirePermission('data.view.own'), (req, res) => {
  const orgId = req.user.organisation_id;
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ leads: [], contacts: [] });

  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  const leadFilter = canSeeOrg ? {} : { ownerUserId: req.user.id };

  const leads = leadRepo.listScoped(orgId, leadFilter)
    .filter(l => (l.company || '').toLowerCase().includes(q))
    .slice(0, MAX_RESULTS);

  const contacts = contactRepo.listByOrganisation(orgId)
    .filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q)
    )
    .slice(0, MAX_RESULTS);

  res.json({ leads, contacts });
});

module.exports = router;