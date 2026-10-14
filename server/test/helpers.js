'use strict';

// Provides an in-memory PostgreSQL backend (pg-mem) for tests.
// Each call to setupFreshTestDb() creates a completely fresh database and
// runs migrations, isolating tests from one another without needing a real
// PostgreSQL server.

const { newDb }                = require('pg-mem');
const { initDb, closeDb, _setPoolForTesting } = require('../db');

async function setupFreshTestDb() {
  await closeDb();
  const mem    = newDb();
  const { Pool } = mem.adapters.createPg();
  _setPoolForTesting(new Pool());
  await initDb();
}

module.exports = { setupFreshTestDb };
