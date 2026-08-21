const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { hasPermission } = require('../permissions');
const clockRepo = require('../repositories/clockRepository');
const auditRepo = require('../repositories/auditRepository');

router.use(requireAuth);

// Clock-in/out is deliberately self-service and NOT gated behind any of the
// data.view.* / *.create permission catalogue used elsewhere in this file:
// every authenticated user (any role, including a plain PIN-provisioned
// AGENT) can clock themselves in or out. There is no permission that means
// "may act on your own attendance" and inventing one would be a distinction
// without a difference — being a valid, non-disabled authenticated user
// (requireAuth already enforces this) IS the requirement. Acting on
// someone else's clock record is never exposed here at all; see GET
// /clock/status and /clock/history below, which only ever read req.user's
// own id, never a client-supplied one.

// GET /clock/status — is the calling user currently clocked in? Drives the
// Clock In vs Clock Out button state in the frontend's new tab.
router.get('/clock/status', (req, res) => {
  const open = clockRepo.getOpenSessionScoped(req.user.organisation_id, req.user.id);
  res.json({ clockedIn: !!open, session: open });
});

// POST /clock/in — starts a new open session. Rejects if one is already
// open, rather than silently closing it — an accidental double clock-in
// should surface as an error the frontend can show, not silently discard
// the first session's start time.
router.post('/clock/in', (req, res) => {
  const existing = clockRepo.getOpenSessionScoped(req.user.organisation_id, req.user.id);
  if (existing) {
    return res.status(409).json({ error: 'Already clocked in', session: existing });
  }
  const session = clockRepo.clockIn(req.user.organisation_id, req.user.id);
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'clock.in', entityType: 'clock_session', entityId: session.id });
  res.status(201).json(session);
});

// POST /clock/out — closes the caller's own open session, if any.
router.post('/clock/out', (req, res) => {
  const closed = clockRepo.clockOut(req.user.organisation_id, req.user.id);
  if (!closed) {
    return res.status(409).json({ error: 'Not currently clocked in' });
  }
  auditRepo.record({ organisationId: req.user.organisation_id, userId: req.user.id, event: 'clock.out', entityType: 'clock_session', entityId: closed.id });
  res.json(closed);
});

// GET /clock/history — the caller's own shift history. ?from=&to= are
// optional ISO-8601 bounds compared against clock_in_at.
router.get('/clock/history', (req, res) => {
  const rows = clockRepo.listForUserScoped(req.user.organisation_id, req.user.id, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json(rows);
});

// GET /clock/all — org-wide shift history, for Owner/Manager review. Uses
// the existing data.view.org permission (same one GET /leads and GET
// /tasks already gate their org-wide view behind) rather than adding a new
// permission-catalog entry for a single read endpoint.
router.get('/clock/all', (req, res) => {
  if (!hasPermission(req.user.role_id, 'data.view.org')) {
    return res.status(403).json({ error: 'Forbidden — missing permission: data.view.org' });
  }
  const rows = clockRepo.listForOrganisation(req.user.organisation_id, {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.json(rows);
});

module.exports = router;
