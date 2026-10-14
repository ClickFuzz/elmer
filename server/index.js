'use strict';

require('dotenv').config({ path: __dirname + '/.env' });

const { createApp } = require('./app');
const { closeDb }   = require('./db');

const PORT = process.env.PORT ?? 3001;
const app  = createApp();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elmer server running on port ${PORT}`);
  console.log(`AI mode:   ${process.env.OPENAI_API_KEY ? 'REAL (OpenAI)' : 'MOCK (no API key)'}`);
  console.log(`Auth mode: ${process.env.DISABLE_AUTH === 'true' ? 'OPEN (DISABLE_AUTH=true)' : 'REQUIRED'}`);
});

function shutdown() {
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
