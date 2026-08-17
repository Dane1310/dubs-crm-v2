const express = require('express');
const { seedPermissionsAndDefaultRoles } = require('./permissions');

seedPermissionsAndDefaultRoles(); // idempotent — safe to run on every boot

const app = express();
app.use(express.json());

// CORS: required for a browser-hosted frontend (a different origin, e.g. a
// Claude artifact or any deployed site) to call this API at all — without
// this, every request fails at the browser level before it even reaches
// the routes below.
//
// PHASE 14: this is now production-configurable via ALLOWED_ORIGIN, per
// explicit instruction not to leave unrestricted `*` as the intended
// production configuration. Set ALLOWED_ORIGIN to a comma-separated list
// of exact origins (e.g. "https://dane.github.io,https://dubs-crm.onrender.com").
// If ALLOWED_ORIGIN is unset, this falls back to `*` (open) ONLY so local
// development and this sandbox's own tests keep working without extra
// setup — that fallback is a development convenience, not the production
// posture, and PHASE14_FINAL_DEPLOYMENT.md says so explicitly.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    // else: no CORS header set at all — browser blocks it. This is the
    // intended production behaviour when ALLOWED_ORIGIN is configured.
  } else {
    res.header('Access-Control-Allow-Origin', '*'); // dev-only fallback, see comment above
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/protected'));
app.use('/api', require('./routes/leads'));
app.use('/api', require('./routes/activities'));
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/search'));
app.use('/api', require('./routes/tasks'));
app.use('/api', require('./routes/contacts'));
app.use('/api', require('./routes/backup'));

// Basic malformed-input / unknown-route safety net — never leak stack traces.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  res.status(400).json({ error: 'Malformed request' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Foundation API listening on :${PORT}`));