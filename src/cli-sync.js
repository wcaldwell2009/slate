'use strict';

// Runs a sync from the command line (used by the daily scheduled task).
// Respects CANVAS_MODE from .env (real Canvas if a token is set, else mock).
require('./load-env');
const { sync } = require('./sync');

(async () => {
  const counts = await sync({ log: (m) => console.log(new Date().toISOString(), m) });
  console.log('Sync complete.', counts);
})().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
