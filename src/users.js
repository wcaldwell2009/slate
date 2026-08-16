'use strict';

// Accounts, sign-in and devices.
//
// Slate started as a single-person app and still behaves like one until there
// is a reason not to: with only the owner account, nobody is asked to log in.
// The moment a second account exists AND the owner has set a password, sign-in
// turns on for everybody. That way adding a friend can never accidentally lock
// Will out of his own app, and the app never nags him for a password he has no
// use for yet.
//
// Passwords are scrypt-hashed with a per-user salt (node:crypto, no
// dependency). Session tokens are random 32-byte values kept in the sessions
// table — one row per signed-in device, which is what the Admin page counts.

const crypto = require('crypto');
const { getDb } = require('./db');

const SESSION_COOKIE = 'slate_session';
const SCRYPT_KEYLEN = 64;

// ---- passwords -----------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  let expected;
  try {
    expected = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const actual = Buffer.from(hashHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---- devices -------------------------------------------------------------
// A user agent turned into something Will can recognise in a list.
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /iPhone/i.test(ua) ? 'iPhone'
      : /iPad/i.test(ua) ? 'iPad'
        : /Android/i.test(ua) ? 'Android'
          : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
            : /Linux/i.test(ua) ? 'Linux' : null;
  // Order matters: Edge and Chrome both claim to be Safari, Edge claims Chrome.
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
      : /Firefox\//i.test(ua) ? 'Firefox'
        : /Chrome\//i.test(ua) ? 'Chrome'
          : /Safari\//i.test(ua) ? 'Safari' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

// ---- lookups -------------------------------------------------------------
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    is_admin: !!row.is_admin,
    is_frozen: !!row.is_frozen,
    is_owner: !!row.is_owner,
    has_password: !!row.password_hash,
  };
}

function owner() {
  return getDb().prepare('SELECT * FROM users WHERE is_owner = 1').get() || null;
}

function userCount() {
  return getDb().prepare('SELECT COUNT(*) n FROM users').get().n;
}

// Sign-in only applies once there's somebody to keep out and the owner can
// actually get back in.
function loginRequired() {
  const o = owner();
  return userCount() > 1 && !!(o && o.password_hash);
}

// ---- sessions ------------------------------------------------------------
function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO sessions (user_id, token, device, ip, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, token, describeDevice(userAgent), String(ip || ''), now, now);
  return token;
}

function sessionUser(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(`SELECT u.*, s.id AS session_id FROM sessions s
              JOIN users u ON u.id = s.user_id
              WHERE s.token = ?`)
    .get(String(token));
  if (!row) return null;
  if (row.is_frozen) { endSession(token); return null; } // frozen mid-session: out you go
  getDb().prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), row.session_id);
  return row;
}

function endSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

function endAllSessions(userId) {
  const info = getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(info.changes || 0);
}

function devicesFor(userId) {
  return getDb()
    .prepare('SELECT id, device, ip, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC')
    .all(userId);
}

// ---- who is asking -------------------------------------------------------
// With sign-in off, every request is the owner — that is the single-user app
// Slate has always been. With it on, the session cookie decides.
function currentUser(token) {
  if (!loginRequired()) return owner();
  return sessionUser(token);
}

function signIn(name, password, meta) {
  const row = getDb().prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(String(name || '').trim());
  // Same message either way — which names exist isn't something to hand out.
  if (!row || !checkPassword(password, row.password_hash)) {
    return { ok: false, error: 'That name and password do not match.' };
  }
  if (row.is_frozen) return { ok: false, error: 'That account is frozen. Ask Will to unfreeze it.' };
  return { ok: true, token: createSession(row.id, meta), user: publicUser(row) };
}

// ---- admin actions -------------------------------------------------------
function listUsers() {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY is_owner DESC, name COLLATE NOCASE').all();
  return rows.map((r) => {
    const devices = devicesFor(r.id);
    return {
      ...publicUser(r),
      created_at: r.created_at,
      devices: devices.length,
      last_seen: devices.length ? devices[0].last_seen : null,
    };
  });
}

function addUser({ name, password, is_admin }) {
  const clean = String(name || '').trim();
  if (clean.length < 2) return { ok: false, error: 'Give them a name (at least 2 letters).' };
  if (String(password || '').length < 4) return { ok: false, error: 'Passwords need to be at least 4 characters.' };
  const taken = getDb().prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(clean);
  if (taken) return { ok: false, error: `There's already someone called ${clean}.` };

  getDb()
    .prepare('INSERT INTO users (name, password_hash, is_admin, is_frozen, is_owner, created_at) VALUES (?, ?, ?, 0, 0, ?)')
    .run(clean, hashPassword(password), is_admin ? 1 : 0, new Date().toISOString());
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

function getUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function setFrozen(id, frozen) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  if (row.is_owner) return { ok: false, error: "You can't freeze your own owner account." };
  getDb().prepare('UPDATE users SET is_frozen = ? WHERE id = ?').run(frozen ? 1 : 0, row.id);
  // Freezing takes effect now, not next time they happen to sign out.
  if (frozen) endAllSessions(row.id);
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

function setAdmin(id, admin) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  if (row.is_owner) return { ok: false, error: 'The owner account is always an admin.' };
  getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(admin ? 1 : 0, row.id);
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

// Admins can correct a name — including their own. The heading on every
// handed-in document comes from this, so "Will" needs to become "Will Caldwell"
// somewhere, and this is that somewhere.
function renameUser(id, name) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  const clean = String(name || '').trim().replace(/\s{2,}/g, ' ');
  if (clean.length < 2) return { ok: false, error: 'Give them a name (at least 2 letters).' };
  if (clean.length > 60) return { ok: false, error: 'That name is too long.' };
  const taken = getDb().prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id != ?').get(clean, row.id);
  if (taken) return { ok: false, error: `There's already someone called ${clean}.` };
  getDb().prepare('UPDATE users SET name = ? WHERE id = ?').run(clean, row.id);
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

function setPassword(id, password) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  if (String(password || '').length < 4) return { ok: false, error: 'Passwords need to be at least 4 characters.' };
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

function removeUser(id) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  if (row.is_owner) return { ok: false, error: "You can't delete your own owner account." };
  endAllSessions(row.id);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return { ok: true, users: listUsers(), login_required: loginRequired() };
}

function signOutDevices(id) {
  const row = getUser(id);
  if (!row) return { ok: false, error: 'No such person.' };
  const n = endAllSessions(row.id);
  return { ok: true, signed_out: n, users: listUsers(), login_required: loginRequired() };
}

function adminOverview() {
  return { login_required: loginRequired(), users: listUsers() };
}

module.exports = {
  SESSION_COOKIE,
  hashPassword, checkPassword, describeDevice,
  owner, userCount, loginRequired, currentUser, publicUser,
  createSession, sessionUser, endSession, endAllSessions, devicesFor,
  signIn,
  adminOverview, listUsers, addUser, setFrozen, setAdmin, setPassword, removeUser, signOutDevices, renameUser,
};
