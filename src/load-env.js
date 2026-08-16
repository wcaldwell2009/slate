'use strict';

// Minimal .env loader — no dependency. Reads KEY=VALUE lines from ../.env
// (if present) into process.env without overwriting existing values.

const fs = require('fs');
const path = require('path');

// The installed copy keeps .env beside its data, not inside the app folder,
// so an update can't wipe the Canvas token. SLATE_HOME points at that folder.
const envPath = process.env.SLATE_HOME
  ? path.join(process.env.SLATE_HOME, '.env')
  : path.join(__dirname, '..', '.env');
try {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  /* no .env file — fine, we default to mock mode */
}

module.exports = {};
