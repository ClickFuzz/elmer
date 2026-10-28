'use strict';

const { Pool } = require('pg');

const SCHEMA_VERSION = 13;

let _pool        = null;
let _initialized = false;

function getPool() {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required. Set it to your PostgreSQL connection string, e.g.: ' +
        'postgresql://user:password@host:5432/dbname'
      );
    }
    const useSSL =
      process.env.NODE_ENV === 'production' ||
      connectionString.includes('sslmode=require') ||
      connectionString.includes('ssl=true');

    _pool = new Pool({
      connectionString,
      ssl: useSSL ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err) => {
      console.error('[elmer] idle PostgreSQL client error:', err.message);
    });
  }
  return _pool;
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT  NOT NULL
      )
    `);

    // Load all applied versions so migrations are incremental.
    const { rows: appliedRows } = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    const applied = new Set(appliedRows.map(r => r.version));

    if (applied.has(SCHEMA_VERSION)) {
      await client.query('COMMIT');
      return;
    }

    // ── V1: initial schema ────────────────────────────────────────────────────
    if (!applied.has(1)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            BIGSERIAL PRIMARY KEY,
          email         TEXT   NOT NULL UNIQUE,
          password_hash TEXT   NOT NULL,
          created_at    BIGINT NOT NULL,
          updated_at    BIGINT NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id         BIGSERIAL PRIMARY KEY,
          user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token      TEXT   NOT NULL UNIQUE,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS business_settings (
          id            BIGSERIAL PRIMARY KEY,
          user_id       BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          settings_json TEXT   NOT NULL DEFAULT '{}',
          updated_at    BIGINT NOT NULL
        )
      `);

      // selected and tasks_json are present from the start on fresh installs.
      await client.query(`
        CREATE TABLE IF NOT EXISTS connected_platforms (
          id                BIGSERIAL PRIMARY KEY,
          user_id           BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          platform          TEXT    NOT NULL
            CHECK(platform IN ('google','facebook','instagram','wordpress','threads')),
          account_name      TEXT    NOT NULL,
          account_id        TEXT    NOT NULL,
          access_token_enc  TEXT,
          refresh_token_enc TEXT,
          token_expires_at  BIGINT,
          selected          BOOLEAN NOT NULL DEFAULT false,
          tasks_json        TEXT,
          connected_at      BIGINT  NOT NULL,
          updated_at        BIGINT  NOT NULL,
          UNIQUE(user_id, platform, account_id)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_states (
          id         BIGSERIAL PRIMARY KEY,
          state      TEXT   NOT NULL UNIQUE,
          user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          platform   TEXT   NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          used_at    BIGINT
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS publishing_records (
          id               BIGSERIAL PRIMARY KEY,
          user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          platform         TEXT   NOT NULL,
          platform_post_id TEXT,
          job_ref          TEXT,
          status           TEXT   NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','published','failed')),
          error_message    TEXT,
          published_at     BIGINT,
          created_at       BIGINT NOT NULL,
          updated_at       BIGINT NOT NULL
        )
      `);

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [1, Date.now()]
      );
    }

    // ── V2: add selected and tasks_json to existing connected_platforms rows ──
    if (!applied.has(2)) {
      await client.query(`
        ALTER TABLE connected_platforms
          ADD COLUMN IF NOT EXISTS selected   BOOLEAN NOT NULL DEFAULT false
      `);
      await client.query(`
        ALTER TABLE connected_platforms
          ADD COLUMN IF NOT EXISTS tasks_json TEXT
      `);
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [2, Date.now()]
      );
    }

    // ── V3: expand platform constraint to include instagram on existing installs ──
    if (!applied.has(3)) {
      try {
        await client.query(`ALTER TABLE connected_platforms DROP CONSTRAINT connected_platforms_platform_check`);
        await client.query(`ALTER TABLE connected_platforms ADD CONSTRAINT connected_platforms_platform_check CHECK(platform IN ('google','facebook','instagram','wordpress'))`);
      } catch {
        // pg-mem / older installs may not support this; app logic enforces valid values
      }
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [3, Date.now()]
      );
    }

    // ── V4: expand platform constraint to include threads ──────────────────────
    if (!applied.has(4)) {
      try {
        await client.query(`ALTER TABLE connected_platforms DROP CONSTRAINT connected_platforms_platform_check`);
        await client.query(`ALTER TABLE connected_platforms ADD CONSTRAINT connected_platforms_platform_check CHECK(platform IN ('google','facebook','instagram','wordpress','threads'))`);
      } catch {
        // pg-mem / older installs may not support this; app logic enforces valid values
      }
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [4, Date.now()]
      );
    }

    // ── V5: Stripe billing tables ─────────────────────────────────────────────
    if (!applied.has(5)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS stripe_customers (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          customer_id TEXT   NOT NULL UNIQUE,
          created_at  BIGINT NOT NULL,
          updated_at  BIGINT NOT NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_stripe_customers_customer ON stripe_customers(customer_id)`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id                     BIGSERIAL PRIMARY KEY,
          user_id                BIGINT  NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          stripe_subscription_id TEXT    UNIQUE,
          stripe_customer_id     TEXT    NOT NULL,
          status                 TEXT    NOT NULL DEFAULT 'none',
          current_period_start   BIGINT,
          current_period_end     BIGINT,
          trial_start            BIGINT,
          trial_end              BIGINT,
          cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
          cancel_at              BIGINT,
          canceled_at            BIGINT,
          trial_used             BOOLEAN NOT NULL DEFAULT false,
          created_at             BIGINT  NOT NULL,
          updated_at             BIGINT  NOT NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_id ON subscriptions(stripe_subscription_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id)`);

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [5, Date.now()]
      );
    }

    // ── V6: free publication tracking ─────────────────────────────────────────
    if (!applied.has(6)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS free_publications (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          status      TEXT NOT NULL DEFAULT 'available'
            CHECK(status IN ('available','reserved','redeemed')),
          job_key     TEXT,
          reserved_at BIGINT,
          redeemed_at BIGINT,
          created_at  BIGINT NOT NULL,
          updated_at  BIGINT NOT NULL
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_free_publications_user ON free_publications(user_id)`
      );

      // client_job_id lets us cross-reference a multi-platform job
      // so release-on-failure can check whether any other platform succeeded.
      try {
        await client.query(
          `ALTER TABLE publishing_records ADD COLUMN IF NOT EXISTS client_job_id TEXT`
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_pr_client_job ON publishing_records(user_id, client_job_id)`
        );
      } catch {
        // pg-mem / older installs may not support all DDL variations
      }

      // Seed existing users (two-step; wrapped in try/catch for pg-mem compatibility).
      // Step 1: all existing users start as 'available'
      // Step 2: flip to 'redeemed' for users that already have published records
      // New users created after migration get their row in the registration handler.
      const seedNow = Date.now();
      try {
        await client.query(
          `INSERT INTO free_publications (user_id, status, created_at, updated_at)
           SELECT u.id, 'available', $1, $1
           FROM users u
           ON CONFLICT (user_id) DO NOTHING`,
          [seedNow]
        );
        await client.query(
          `UPDATE free_publications
           SET status = 'redeemed', redeemed_at = $1, updated_at = $1
           WHERE status = 'available'
             AND user_id IN (
               SELECT DISTINCT user_id FROM publishing_records WHERE status = 'published'
             )`,
          [seedNow]
        );
      } catch {
        // pg-mem does not support INSERT...SELECT with ON CONFLICT; safe to skip in tests
        // (fresh test databases have no existing users to seed)
      }

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [6, Date.now()]
      );
    }

    // ── V7: device update retry queue ──────────────────────────────────────────
    // Tracks Apple DeviceCheck bit-update obligations that failed after a
    // successful free publication. The device token that triggered the obligation
    // has already expired, so each row records the USER and JOB — not the token.
    // The next request from this user that includes a fresh device token will
    // fulfil the obligation and remove the row.
    if (!applied.has(7)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS device_update_queue (
          id            BIGSERIAL PRIMARY KEY,
          user_id       BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_key       TEXT    NOT NULL,
          platform      TEXT    NOT NULL DEFAULT 'ios',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error    TEXT,
          created_at    BIGINT  NOT NULL,
          updated_at    BIGINT  NOT NULL,
          UNIQUE(user_id, job_key)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_device_update_queue_user ON device_update_queue(user_id)`
      );

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [7, Date.now()]
      );
    }

    // ── V8: Stripe webhook event deduplication ────────────────────────────────
    // Prevents duplicate analytics events and double-state-transitions when
    // Stripe retries webhook delivery.
    if (!applied.has(8)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS stripe_webhook_events (
          event_id   TEXT    PRIMARY KEY,
          event_type TEXT    NOT NULL,
          processed_at BIGINT NOT NULL
        )
      `);

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [8, Date.now()]
      );
    }

    // ── V9: content_hash on publishing_records ────────────────────────────────
    // Locks the content of a free-publication retry to the original submitted
    // content, preventing content-replacement attacks on retry paths.
    // Also adds destination_locked flag for explicit new-destination rejection.
    if (!applied.has(9)) {
      try {
        await client.query(
          `ALTER TABLE publishing_records ADD COLUMN IF NOT EXISTS content_hash TEXT`
        );
      } catch {
        // pg-mem may not support all DDL variations
      }

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [9, Date.now()]
      );
    }

    // ── V10: reviewer bypass account ─────────────────────────────────────────
    // Ensures review@clickfuzz.com exists with an active subscription so the
    // account passes the paywall gate without a Stripe payment.
    // current_period_end = 2099-01-01T00:00:00Z (4070908800000 ms) keeps it
    // active indefinitely without any recurring Stripe event.
    if (!applied.has(10)) {
      const reviewEmail    = 'review@clickfuzz.com';
      const reviewPassHash = '$2a$12$oLMXjBAkHvEI7shRvCTEJe2Nh159LkFs8w.qwHTxFfEWefhXCRzf.';
      const reviewCusId    = 'cus_review_bypass';
      const reviewSubId    = 'sub_review_bypass';
      const farFuture      = 4070908800000; // 2099-01-01
      const now            = Date.now();

      // 1. Create the account if it does not already exist.
      await client.query(
        `INSERT INTO users (email, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (email) DO NOTHING`,
        [reviewEmail, reviewPassHash, now]
      );

      // 2. Ensure a stripe_customers row exists (needed by the subscriptions FK).
      await client.query(
        `INSERT INTO stripe_customers (user_id, customer_id, created_at, updated_at)
         SELECT id, $1, $2::BIGINT, $2::BIGINT FROM users WHERE email = $3
         ON CONFLICT (user_id) DO NOTHING`,
        [reviewCusId, now, reviewEmail]
      );

      // 3. Upsert an active subscription that never expires.
      await client.query(
        `INSERT INTO subscriptions
           (user_id, stripe_subscription_id, stripe_customer_id, status,
            current_period_start, current_period_end, trial_used, created_at, updated_at)
         SELECT id, $1, $2, 'active', $3::BIGINT, $4::BIGINT, true, $3::BIGINT, $3::BIGINT
         FROM users WHERE email = $5
         ON CONFLICT (user_id) DO UPDATE SET
           status               = 'active',
           current_period_end   = $4::BIGINT,
           cancel_at_period_end = false,
           canceled_at          = NULL,
           updated_at           = $3::BIGINT`,
        [reviewSubId, reviewCusId, now, farFuture, reviewEmail]
      );

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [10, Date.now()]
      );
    }

    // ── V11: settings versioning ──────────────────────────────────────────────
    // Adds a monotonically-increasing version counter to business_settings so
    // devices can detect and safely resolve concurrent settings updates without
    // silently overwriting newer data from another device.
    if (!applied.has(11)) {
      try {
        await client.query(
          `ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS settings_version INTEGER NOT NULL DEFAULT 0`
        );
      } catch {
        // pg-mem may not support all DDL variations
      }

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [11, Date.now()]
      );
    }

    // ── V12: Meta platform_user_id mapping ───────────────────────────────────
    // Adds a nullable column to connected_platforms that stores the Meta
    // app-scoped user ID alongside each connected page/account row.
    // Used by Facebook deauth/deletion callbacks to identify which rows
    // belong to the user who revoked access.  Existing rows default to NULL
    // and are safely handled by the callback handlers (they just skip deletion
    // for rows with no mapping and never touch other users' data).
    if (!applied.has(12)) {
      try {
        await client.query(
          `ALTER TABLE connected_platforms ADD COLUMN IF NOT EXISTS platform_user_id TEXT`
        );
      } catch {
        // pg-mem may not support IF NOT EXISTS on ALTER COLUMN
      }

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [12, Date.now()]
      );
    }

    // ── V13: Meta deletion request tracking ──────────────────────────────────
    // Persists confirmation codes and statuses for Meta data-deletion callbacks
    // (Facebook, Instagram, Threads).  Status URLs query this table by code so
    // they return accurate outcomes rather than a static page.  Status values:
    //   pending   – deletion in progress
    //   completed – data successfully deleted (or confirmed not present)
    //   failed    – deletion attempted but DB error occurred
    //   no_data   – identity could not be fully resolved (legacy NULL rows)
    if (!applied.has(13)) {
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS deletion_requests (
            id                BIGSERIAL PRIMARY KEY,
            platform          TEXT    NOT NULL,
            confirmation_code TEXT    NOT NULL UNIQUE,
            status            TEXT    NOT NULL DEFAULT 'pending',
            connections_deleted INTEGER NOT NULL DEFAULT 0,
            records_deleted     INTEGER NOT NULL DEFAULT 0,
            created_at        BIGINT  NOT NULL,
            completed_at      BIGINT
          )
        `);
      } catch {
        // pg-mem may not support all DDL
      }

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [13, Date.now()]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initDb() {
  const pool = getPool();
  if (!_initialized) {
    await migrate(pool);
    _initialized = true;
    cleanExpiredSessions().catch(err =>
      console.warn('[elmer] session cleanup error:', err.message)
    );
    cleanExpiredPublishingRecords().catch(err =>
      console.warn('[elmer] publishing records cleanup error:', err.message)
    );
    cleanStaleFreePublicationReservations().catch(err =>
      console.warn('[elmer] reservation cleanup error:', err.message)
    );
  }
  return pool;
}

async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool        = null;
    _initialized = false;
  }
}

async function cleanExpiredSessions() {
  await getPool().query(
    'DELETE FROM sessions WHERE expires_at < $1',
    [Date.now()]
  );
}

async function cleanExpiredPublishingRecords() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await getPool().query(
    "DELETE FROM publishing_records WHERE status = 'published' AND published_at IS NOT NULL AND published_at < $1",
    [cutoff]
  );
}

// Release free_publications rows stuck in 'reserved' for more than 1 hour
// that have no corresponding successful publishing record.
async function cleanStaleFreePublicationReservations() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const pool = getPool();
  try {
    // Find stale reserved rows
    const { rows: stale } = await pool.query(
      `SELECT user_id, job_key FROM free_publications
       WHERE status = 'reserved' AND reserved_at IS NOT NULL AND reserved_at < $1`,
      [cutoff]
    );
    const now = Date.now();
    for (const row of stale) {
      // Check if any platform succeeded for this job
      const { rows: success } = await pool.query(
        `SELECT 1 FROM publishing_records
         WHERE user_id = $1 AND status = 'published' AND client_job_id = $2 LIMIT 1`,
        [row.user_id, row.job_key]
      );
      if (success.length > 0) {
        await pool.query(
          `UPDATE free_publications
           SET status = 'redeemed', redeemed_at = $2, updated_at = $2
           WHERE user_id = $1 AND status = 'reserved'`,
          [row.user_id, now]
        );
      } else {
        await pool.query(
          `UPDATE free_publications
           SET status = 'available', job_key = null, reserved_at = null, updated_at = $2
           WHERE user_id = $1 AND status = 'reserved'`,
          [row.user_id, now]
        );
      }
    }
  } catch (err) {
    console.warn('[elmer] stale reservation cleanup error:', err.message);
  }
}

// Test-only: inject a mock pool (e.g. pg-mem). Resets initialisation state.
function _setPoolForTesting(pool) {
  if (_pool && _pool !== pool) {
    _pool.end().catch(() => {});
  }
  _pool        = pool;
  _initialized = false;
}

module.exports = { getPool, initDb, closeDb, cleanExpiredSessions, cleanExpiredPublishingRecords, cleanStaleFreePublicationReservations, _setPoolForTesting };
