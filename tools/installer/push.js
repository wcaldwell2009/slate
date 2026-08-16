'use strict';

// "Push it" — take everything in the workshop and make it the real Slate.
//
// Builds a fresh snapshot, then runs the installer, which closes the running
// copy, deletes the old app folder and lays the new one down. Data, notes and
// the Canvas token are outside the app folder, so none of that is at risk.

const { spawnSync } = require('child_process');
const path = require('path');
const { build } = require('./build');

function push({ log = console.log } = {}) {
  const stamp = build({ log });

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'install.ps1')],
    { stdio: 'inherit', env: { ...process.env, SLATE_INSTALL_QUIET: '1' } }
  );

  if (result.status !== 0) {
    log(`\nInstall failed (exit ${result.status}). The installed Slate is unchanged.`);
    process.exitCode = 1;
    return null;
  }
  return stamp;
}

if (require.main === module) push();

module.exports = { push };
