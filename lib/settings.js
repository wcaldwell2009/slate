// One tiny JSON file of user choices (the model picker lives here). Kept in
// the home folder so it survives updates to this project folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = process.env.COPILOT_SETTINGS
  || path.join(os.homedir(), '.browser-copilot.json');

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export const MODELS = ['sonnet', 'opus', 'haiku'];

export function currentModel() {
  const saved = readSettings().model;
  if (MODELS.includes(saved)) return saved;
  return process.env.COPILOT_MODEL || 'sonnet';
}
