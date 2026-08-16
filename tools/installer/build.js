'use strict';

// Freezes the working copy of Slate into an installable snapshot.
//
// The folder on the Desktop is the workshop — edits land there and get looked
// at on localhost. This script takes a copy of it into dist/slate-app, which is
// what "Install Slate.bat" actually installs. That separation is the whole
// point: nothing reaches the installed app until a build is run on purpose.

const fs = require('fs');
const path = require('path');
const { buildIco } = require('./icon');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const SNAPSHOT = path.join(DIST, 'slate-app');

// What the app needs to run. Anything not listed here stays in the workshop —
// notably CLAUDE.md, which the hidden `claude -p` calls would otherwise read
// and start answering as if it were talking to Will (that bug is round 18).
const INCLUDE = ['server.js', 'package.json', 'src', 'public', 'branding'];

function copyInto(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyInto(path.join(src, name), path.join(dest, name));
  } else {
    fs.copyFileSync(src, dest);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function readBuildNumber() {
  try {
    return Number(JSON.parse(fs.readFileSync(path.join(DIST, 'build.json'), 'utf8')).build) || 0;
  } catch {
    return 0;
  }
}

function build({ log = console.log } = {}) {
  const build = readBuildNumber() + 1;
  const built_at = new Date().toISOString();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  fs.rmSync(SNAPSHOT, { recursive: true, force: true });
  fs.mkdirSync(SNAPSHOT, { recursive: true });
  for (const name of INCLUDE) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) throw new Error(`missing ${name} — cannot build a snapshot without it`);
    copyInto(src, path.join(SNAPSHOT, name));
  }

  const stamp = { build, built_at, version };
  fs.writeFileSync(path.join(SNAPSHOT, 'build.json'), JSON.stringify(stamp, null, 2));
  fs.writeFileSync(path.join(DIST, 'build.json'), JSON.stringify(stamp, null, 2));
  fs.writeFileSync(path.join(DIST, 'Slate.ico'), buildIco());

  log(`Snapshot built: build ${build} (${countFiles(SNAPSHOT)} files) -> dist/slate-app`);
  return stamp;
}

if (require.main === module) build();

module.exports = { build, SNAPSHOT, DIST };
