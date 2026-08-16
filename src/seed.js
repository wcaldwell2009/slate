'use strict';

// Wipes the local DB and repopulates it from the mock Canvas API.
// Run with: npm run seed
process.env.CANVAS_MODE = 'mock';

const { resetDb } = require('./db');
const { sync } = require('./sync');

(async () => {
  resetDb();
  const counts = await sync({ log: (m) => console.log(m) });
  console.log('Seed complete.', counts);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
