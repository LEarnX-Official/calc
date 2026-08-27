/**
 * Session auth: bcrypt password hashes, random opaque session tokens in an
 * httpOnly cookie. No JWT — sessions in the DB can be revoked, which matters
 * more here than statelessness.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, now, id } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'qc_session';

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) {
  try { return bcrypt.compareSync(pw, hash); } catch (_) { return false; }
}

function createSession(tenantId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, tenant_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, tenantId, now(), expires);
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function tenantFromRequest(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT t.* FROM sessions s
    JOIN tenants t ON t.id = s.tenant_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now());
  return row || null;
}

/** Route guard. Returns 401 JSON rather than redirecting — the dashboard is a fetch client. */
function requireAuth(req, res, next) {
  const tenant = tenantFromRequest(req);
  if (!tenant) return res.status(401).json({ error: 'Not signed in.' });
  req.tenant = tenant;
  next();
}

function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expires),
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Housekeeping — cheap enough to run on boot. */
function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession,
  tenantFromRequest, requireAuth, setSessionCookie, clearSessionCookie,
  purgeExpiredSessions, COOKIE
};
