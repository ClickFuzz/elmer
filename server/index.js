'use strict';

require('dotenv').config({ path: __dirname + '/.env' });

if (process.env.NODE_ENV === 'production' && process.env.DISABLE_AUTH === 'true') {
  console.error('[elmer] FATAL: DISABLE_AUTH=true is not allowed in production.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && !process.env.CREDENTIAL_ENCRYPTION_KEY) {
  console.error('[elmer] FATAL: CREDENTIAL_ENCRYPTION_KEY must be set in production.');
  process.exit(1);
}

const { createApp } = require('./app');
const { initDb, closeDb } = require('./db');
const { logPendingDeviceUpdates, isDeviceCheckConfigured } = require('./routes/device');

const PORT = process.env.PORT ?? 3001;

async function start() {
  await initDb();
  logPendingDeviceUpdates().catch(() => {});

  const app    = createApp();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Elmer server running on port ${PORT}`);
    console.log(`AI mode:      ${process.env.OPENAI_API_KEY ? 'REAL (OpenAI)' : 'MOCK (no API key)'}`);
    console.log(`Auth mode:    ${process.env.DISABLE_AUTH === 'true' ? 'OPEN (DISABLE_AUTH=true)' : 'REQUIRED'}`);
    console.log(`DeviceCheck:  ${isDeviceCheckConfigured() ? 'ENABLED (iOS device protection active)' : 'DISABLED (set APPLE_DEVICECHECK_* vars to enable)'}`);
    console.log(`DB:           PostgreSQL`);
  });

  async function shutdown() {
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

start().catch(err => {
  console.error('[elmer] Failed to start:', err.message);
  process.exit(1);
});
