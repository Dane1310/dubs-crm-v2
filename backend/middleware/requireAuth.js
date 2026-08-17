const { getSession } = require('../auth');
const db = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated — no token provided' });

  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated — invalid or expired session' });

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Not authenticated — user inactive' });

  // req.user.organisation_id comes from the SERVER-VERIFIED session record,
  // never from anything the client sends in the request body/query —
  // this is what makes cross-org access structurally hard to fake.
  req.user = user;
  req.sessionToken = token;
  next();
}

module.exports = requireAuth;