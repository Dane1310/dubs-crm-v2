// permissions.js — ONE central place permission checks happen.
// Nothing else in the codebase should scatter its own role-name checks;
// every protected route calls hasPermission() / requirePermission().

const db = require('./db');

const CATALOG = [
  ['data.view.own',   'View records the user owns'],
  ['data.view.team',  'View records belonging to the user\'s team'],
  ['data.view.org',   'View all records in the organisation'],
  ['users.manage',    'Create/edit/disable users in the organisation'],
  ['config.manage',   'Change organisation configuration'],
  ['audit.view',      'View the organisation audit log'],
  ['owner.restricted','Perform owner-only restricted operations'],
  // Phase 4 additions.
  ['lead.create',     'Create a new lead'],
  ['lead.edit',       'Edit a lead (own leads always allowed if data.view.own is held; org-wide edit requires data.view.org)'],
  // Phase 5 additions — same catalogue, same requirePermission() mechanism.
  ['activity.create', 'Log a new activity (call/email/whatsapp/meeting/note/other)'],
  ['activity.edit',   'Edit a logged activity (own always allowed; org-wide requires data.view.org)'],
  ['task.create',     'Create a task/follow-up'],
  ['task.edit',       'Edit or complete a task (own always allowed; org-wide requires data.view.org)'],
  // Phase 6 additions — same catalogue, same mechanism. Contacts could
  // previously only be created inline at lead-creation time; these permit
  // standalone contact create/edit now that those routes exist.
  ['contact.create',  'Create a new contact (standalone, or attached to a lead)'],
  ['contact.edit',    'Edit a contact (own-lead\'s contact always allowed; org-wide requires data.view.org)'],
];

const DEFAULT_ROLES = {
  OWNER:   ['data.view.own','data.view.team','data.view.org','users.manage','config.manage','audit.view','owner.restricted','lead.create','lead.edit','activity.create','activity.edit','task.create','task.edit','contact.create','contact.edit'],
  MANAGER: ['data.view.own','data.view.team','data.view.org','audit.view','lead.create','lead.edit','activity.create','activity.edit','task.create','task.edit','contact.create','contact.edit'],
  SENIOR:  ['data.view.own','data.view.team','lead.create','lead.edit','activity.create','activity.edit','task.create','task.edit','contact.create','contact.edit'],
  AGENT:   ['data.view.own','lead.create','lead.edit','activity.create','activity.edit','task.create','task.edit','contact.create','contact.edit'],
};

function seedPermissionsAndDefaultRoles() {
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO permissions (id, key, description) VALUES (?, ?, ?)`);
  for (const [key, description] of CATALOG) {
    insertPerm.run('perm_' + key, key, description);
  }
  const insertRole = db.prepare(`INSERT OR IGNORE INTO roles (id, organisation_id, name) VALUES (?, NULL, ?)`);
  const insertRolePerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`);
  for (const [roleName, permKeys] of Object.entries(DEFAULT_ROLES)) {
    const roleId = 'role_default_' + roleName.toLowerCase();
    insertRole.run(roleId, roleName);
    for (const key of permKeys) {
      insertRolePerm.run(roleId, 'perm_' + key);
    }
  }
}

function hasPermission(userRoleId, permissionKey) {
  const row = db.prepare(
    `SELECT 1 FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ? AND p.key = ?`
  ).get(userRoleId, permissionKey);
  return !!row;
}

// Express middleware factory — the ONLY way routes should gate on permissions.
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasPermission(req.user.role_id, permissionKey)) {
      return res.status(403).json({ error: `Forbidden — missing permission: ${permissionKey}` });
    }
    next();
  };
}

module.exports = { seedPermissionsAndDefaultRoles, hasPermission, requirePermission, DEFAULT_ROLES };