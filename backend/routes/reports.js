const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { requirePermission, hasPermission } = require('../permissions');
const leadRepo = require('../repositories/leadRepository');
const activityRepo = require('../repositories/activityRepository');
const taskRepo = require('../repositories/taskRepository');
const userRepo = require('../repositories/userRepository');
const { effectiveWeights } = require('../config/leaderboardConfig');
const { periodBounds, computeAgentPeriod, weightedScore } = require('../leaderboardMath');

router.use(requireAuth);

// GET /reports/leaderboard — daily/weekly/monthly per-agent metrics.
// Visible to any authenticated org member (data.view.own is enough — the
// competitive leaderboard is intentionally visible to agents per
// instruction); underlying per-lead detail is NOT returned here, only
// aggregate counts, so this does not leak another agent's private records.
router.get('/reports/leaderboard', requirePermission('data.view.own'), (req, res) => {
  const orgId = req.user.organisation_id;
  const users = userRepo.listByOrganisation(orgId).filter(u => u.status === 'active');
  const allActivities = activityRepo.listScoped(orgId);
  const allLeads = leadRepo.listScoped(orgId, { includeArchived: true });
  const allTasks = taskRepo.listScoped(orgId);

  const now = new Date();
  const periods = ['daily', 'weekly', 'monthly'];
  const agents = users.map(u => {
    const byPeriod = {};
    for (const p of periods) {
      const metrics = computeAgentPeriod(u, p, periodBounds(p, now), allActivities, allLeads, allTasks);
      byPeriod[p] = { metrics, score: weightedScore(metrics) };
    }
    return {
      userId: u.id,
      displayName: u.display_name || u.email,
      daily: byPeriod.daily,
      weekly: byPeriod.weekly,
      monthly: byPeriod.monthly,
    };
  });

  // Leader per period, for the blue/purple comparative colouring the
  // frontend needs for Client Response Rate and No Conversion.
  const leaders = {};
  for (const p of periods) {
    let best = null;
    for (const a of agents) {
      const rate = a[p].metrics.clientResponseRate.percent;
      if (rate !== null && (best === null || rate > best.rate)) best = { userId: a.userId, rate };
    }
    leaders[p] = best ? best.userId : null;
  }

  res.json({ generatedAt: now.toISOString(), weights: effectiveWeights(), leaders, agents });
});

// GET /reports/summary — read-only rollup over data that is already
// authoritative in the backend (leads, activities, tasks). Visibility
// mirrors every other tab: own-scoped callers get their own numbers only
// (and no byOwner breakdown, since that would leak other users' data);
// org-scoped callers (data.view.org) get org-wide totals plus a
// per-owner breakdown. Nothing here reads LEADS[]/LEADS[].log[] — this is
// exactly the "backend serving what the frontend already expects" gap,
// not a new feature.
router.get('/reports/summary', requirePermission('data.view.own'), (req, res) => {
  const orgId = req.user.organisation_id;
  const canSeeOrg = hasPermission(req.user.role_id, 'data.view.org');
  const ownerFilter = canSeeOrg ? {} : { ownerUserId: req.user.id };

  const activeLeads = leadRepo.listScoped(orgId, ownerFilter);
  const allLeads = leadRepo.listScoped(orgId, Object.assign({}, ownerFilter, { includeArchived: true }));
  const archivedCount = allLeads.length - activeLeads.length;

  const byStage = {};
  for (const lead of activeLeads) {
    byStage[lead.stage] = (byStage[lead.stage] || 0) + 1;
  }
  const converted = activeLeads.filter(l => l.stage === 'Converted').length;
  const conversionRate = activeLeads.length > 0 ? (converted / activeLeads.length) * 100 : null;

  const activityFilter = canSeeOrg ? {} : { userId: req.user.id };
  const activities = activityRepo.listScoped(orgId, activityFilter);

  const taskFilter = canSeeOrg ? {} : { assignedUserId: req.user.id };
  const tasks = taskRepo.listScoped(orgId, taskFilter);
  const tasksOpen = tasks.filter(t => t.status === 'open').length;
  const tasksDone = tasks.filter(t => t.status === 'done').length;

  let byOwner = [];
  if (canSeeOrg) {
    const users = userRepo.listByOrganisation(orgId);
    byOwner = users.map(u => {
      const userLeads = activeLeads.filter(l => l.owner_user_id === u.id);
      return {
        ownerName: u.email,
        leadsTotal: userLeads.length,
        leadsConverted: userLeads.filter(l => l.stage === 'Converted').length,
        activitiesTotal: activities.filter(a => a.user_id === u.id).length,
        tasksOpen: tasks.filter(t => t.assigned_user_id === u.id && t.status === 'open').length,
        tasksDone: tasks.filter(t => t.assigned_user_id === u.id && t.status === 'done').length,
      };
    });
  }

  res.json({
    leads: {
      total: activeLeads.length,
      archived: archivedCount,
      converted,
      conversionRate,
      byStage,
    },
    activities: { total: activities.length },
    tasks: { open: tasksOpen, done: tasksDone, total: tasks.length },
    byOwner,
  });
});

module.exports = router;