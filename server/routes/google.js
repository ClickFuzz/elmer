'use strict';

const { Router }      = require('express');
const { randomBytes, createHash } = require('crypto');
const fs              = require('fs');
const path            = require('path');
const multer          = require('multer');
const { getPool }     = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { requireAuth } = require('../auth');
const { tryReserveFreePublication, redeemFreePublication, releaseFreePublicationIfNoSuccess, checkFreeRetryAllowed } = require('./billing');
const { trackFreePublicationCompleted, trackPublicationResult } = require('../services/analytics');
const { orderWithFeaturedFirst } = require('./media-utils');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const ACCOUNTS_API      = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const LOCATIONS_API     = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const LOCAL_POSTS_API   = 'https://mybusiness.googleapis.com/v4';

// GBP local post character limit
const GBP_SUMMARY_MAX = 1500;

function formatAddress(addr) {
  if (!addr) return '';
  const parts = [];
  if (addr.addressLines?.length) parts.push(addr.addressLines[0]);
  if (addr.locality) parts.push(addr.locality);
  if (addr.administrativeArea) parts.push(addr.administrativeArea);
  return parts.join(', ');
}

function createGoogleRouter({ apiFetch = (...args) => fetch(...args) } = {}) {
  const TMP_DIR = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
  const upload = multer({ dest: TMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

  const router = Router();

  // ── Token helpers ────────────────────────────────────────────────────────────

  async function _doRefresh(userId, pool) {
    const clientId     = process.env.GOOGLE_CLIENT_ID     ?? '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';

    const { rows } = await pool.query(
      `SELECT id, refresh_token_enc FROM connected_platforms
       WHERE user_id = $1 AND platform = 'google' AND refresh_token_enc IS NOT NULL
       ORDER BY id LIMIT 1`,
      [userId]
    );

    if (!rows[0]) {
      throw Object.assign(
        new Error('Google account not connected or refresh token missing. Please reconnect.'),
        { isAuthError: true }
      );
    }

    const refreshToken = decrypt(rows[0].refresh_token_enc);
    const resp = await apiFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });

    const data = await resp.json();
    if (data.error) {
      throw Object.assign(
        new Error(`Token refresh: ${data.error_description ?? data.error}`),
        { isAuthError: true }
      );
    }

    const newAccessTokenEnc = encrypt(data.access_token);
    const newExpiry = Date.now() + ((data.expires_in ?? 3600) * 1000);

    await pool.query(
      `UPDATE connected_platforms
       SET access_token_enc = $1, token_expires_at = $2, updated_at = $3
       WHERE user_id = $4 AND platform = 'google'`,
      [newAccessTokenEnc, newExpiry, Date.now(), userId]
    );

    return data.access_token;
  }

  // Returns a valid (non-expired) access token, refreshing if needed.
  async function getValidToken(userId, pool) {
    const { rows } = await pool.query(
      `SELECT access_token_enc, token_expires_at
       FROM connected_platforms
       WHERE user_id = $1 AND platform = 'google' AND access_token_enc IS NOT NULL
       ORDER BY id LIMIT 1`,
      [userId]
    );

    if (!rows[0]) {
      throw Object.assign(new Error('No Google account connected.'), { isAuthError: true });
    }

    const { access_token_enc, token_expires_at } = rows[0];
    // Refresh proactively if expiring within 5 minutes
    if (token_expires_at && token_expires_at - Date.now() < 5 * 60 * 1000) {
      return _doRefresh(userId, pool);
    }

    return decrypt(access_token_enc);
  }

  // ── POST /google/connect-url ─────────────────────────────────────────────────
  router.post('/connect-url', requireAuth, async (req, res, next) => {
    try {
      const clientId   = process.env.GOOGLE_CLIENT_ID    ?? '';
      const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? '';

      if (!clientId || !redirectUri) {
        return res.status(503).json({ error: 'Google integration not configured on this server' });
      }

      const state = randomBytes(24).toString('hex');
      const now   = Date.now();

      await getPool().query(
        `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
         VALUES ($1, $2, 'google', $3, $4)`,
        [state, req.userId, now, now + OAUTH_STATE_TTL_MS]
      );

      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         GBP_SCOPE,
        access_type:   'offline',
        prompt:        'consent',
        state,
      });

      return res.json({ authUrl: `${GOOGLE_AUTH_URL}?${params}` });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /google/callback ─────────────────────────────────────────────────────
  router.get('/callback', async (req, res) => {
    const clientId     = process.env.GOOGLE_CLIENT_ID     ?? '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI  ?? '';
    const returnScheme = process.env.GOOGLE_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase   = `${returnScheme}://oauth/callback`;

    const { code, state, error: googleError } = req.query;
    console.log('[google] callback — code:', !!code, '| state:', !!state, '| error:', googleError ?? 'none');

    if (googleError) {
      return res.redirect(`${returnBase}?platform=google&error=${encodeURIComponent(String(googleError))}`);
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return res.redirect(`${returnBase}?platform=google&error=missing_params`);
    }

    if (!clientId || !clientSecret || !redirectUri) {
      return res.redirect(`${returnBase}?platform=google&error=server_not_configured`);
    }

    const pool = getPool();
    const now  = Date.now();

    // Atomically validate + consume state token
    const client = await pool.connect();
    let stateRow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, user_id, expires_at, used_at
         FROM oauth_states WHERE state = $1 AND platform = 'google'
         FOR UPDATE`,
        [state]
      );
      stateRow = rows[0];

      if (!stateRow) {
        await client.query('ROLLBACK');
        return res.redirect(`${returnBase}?platform=google&error=invalid_state`);
      }
      if (stateRow.used_at) {
        await client.query('ROLLBACK');
        return res.redirect(`${returnBase}?platform=google&error=state_already_used`);
      }
      if (stateRow.expires_at < now) {
        await client.query('ROLLBACK');
        return res.redirect(`${returnBase}?platform=google&error=state_expired`);
      }

      await client.query('UPDATE oauth_states SET used_at = $1 WHERE id = $2', [now, stateRow.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    try {
      // Step 1 — Exchange code for tokens
      const tokenResp = await apiFetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }),
      });
      const tokenData = await tokenResp.json();

      if (tokenData.error) {
        throw new Error(`Token exchange: ${tokenData.error_description ?? tokenData.error}`);
      }

      const accessToken  = tokenData.access_token;
      const refreshToken = tokenData.refresh_token ?? null;
      const expiresIn    = tokenData.expires_in ?? 3600;
      const expiresAt    = now + expiresIn * 1000;

      // Step 2 — Fetch accounts (pageSize=50 covers typical use)
      const accountsResp = await apiFetch(`${ACCOUNTS_API}?pageSize=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const accountsData = await accountsResp.json();

      if (accountsData.error) {
        throw new Error(`Accounts fetch: ${accountsData.error.message ?? JSON.stringify(accountsData.error)}`);
      }

      const accounts = accountsData.accounts ?? [];
      if (accounts.length === 0) {
        return res.redirect(`${returnBase}?platform=google&error=no_business_accounts`);
      }

      // Step 3 — Fetch locations for each account
      const allLocations = [];
      for (const account of accounts) {
        let pageToken = null;
        do {
          const locUrl = new URL(`${LOCATIONS_API}/${account.name}/locations`);
          locUrl.searchParams.set('readMask', 'name,title,storefrontAddress,websiteUri');
          locUrl.searchParams.set('pageSize', '100');
          if (pageToken) locUrl.searchParams.set('pageToken', pageToken);

          const locResp = await apiFetch(locUrl.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const locData = await locResp.json();

          if (locData.error) {
            console.warn('[google] locations error for', account.name, ':', locData.error.message);
            break;
          }

          for (const loc of locData.locations ?? []) {
            allLocations.push({
              accountName:  account.name,   // accounts/{accountId}
              locationName: loc.name,       // locations/{locationId}
              title:        loc.title ?? 'Business Location',
              address:      formatAddress(loc.storefrontAddress),
            });
          }

          pageToken = locData.nextPageToken ?? null;
        } while (pageToken);
      }

      if (allLocations.length === 0) {
        return res.redirect(`${returnBase}?platform=google&error=no_locations`);
      }

      // Step 4 — Persist each location
      const accessTokenEnc  = encrypt(accessToken);
      const refreshTokenEnc = refreshToken ? encrypt(refreshToken) : null;

      for (const loc of allLocations) {
        // Full path used by the My Business v4 API for local posts
        const fullPath    = `${loc.accountName}/${loc.locationName}`; // accounts/X/locations/Y
        const displayName = loc.address ? `${loc.title} — ${loc.address}` : loc.title;
        const tasksJson   = JSON.stringify({ locationTitle: loc.title, locationAddress: loc.address });

        await pool.query(
          `INSERT INTO connected_platforms
             (user_id, platform, account_name, account_id, access_token_enc, refresh_token_enc,
              token_expires_at, selected, tasks_json, connected_at, updated_at)
           VALUES ($1, 'google', $2, $3, $4, $5, $6, true, $7, $8, $9)
           ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
             account_name      = EXCLUDED.account_name,
             access_token_enc  = EXCLUDED.access_token_enc,
             refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, connected_platforms.refresh_token_enc),
             token_expires_at  = EXCLUDED.token_expires_at,
             tasks_json        = EXCLUDED.tasks_json,
             updated_at        = EXCLUDED.updated_at`,
          [
            stateRow.user_id,
            displayName,
            fullPath,
            accessTokenEnc,
            refreshTokenEnc,
            expiresAt,
            tasksJson,
            now,
            now,
          ]
        );
      }

      return res.redirect(
        `${returnBase}?platform=google&success=true&location_count=${allLocations.length}`
      );
    } catch (err) {
      console.error('[google] callback error:', err.message);
      return res.redirect(`${returnBase}?platform=google&error=auth_failed`);
    }
  });

  // ── GET /google/locations ────────────────────────────────────────────────────
  router.get('/locations', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await getPool().query(
        `SELECT id, account_name, account_id, selected, token_expires_at, connected_at, tasks_json
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'google'
         ORDER BY account_name ASC`,
        [req.userId]
      );
      return res.json({ locations: rows });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /google/locations/selection ────────────────────────────────────────
  router.post('/locations/selection', requireAuth, async (req, res, next) => {
    try {
      const { location_ids } = req.body ?? {};
      if (!Array.isArray(location_ids)) {
        return res.status(400).json({ error: 'location_ids must be an array' });
      }
      const ids = location_ids
        .map(id => parseInt(id, 10))
        .filter(id => Number.isInteger(id) && id > 0);

      const pool = getPool();
      await pool.query(
        `UPDATE connected_platforms SET selected = false WHERE user_id = $1 AND platform = 'google'`,
        [req.userId]
      );
      for (const id of ids) {
        await pool.query(
          `UPDATE connected_platforms SET selected = true
           WHERE user_id = $1 AND platform = 'google' AND id = $2`,
          [req.userId, id]
        );
      }
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /google/media/:filename ──────────────────────────────────────────────
  // Serves temporarily staged images for GBP API to fetch via sourceUrl.
  router.get('/media/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/i.test(filename)) {
      return res.status(404).end();
    }
    const filepath = path.join(TMP_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(path.resolve(filepath));
  });

  // ── POST /google/publish ─────────────────────────────────────────────────────
  router.post('/publish', requireAuth, upload.any(), async (req, res) => {
    const uploadedFiles = req.files ?? [];
    const cleanup = () => {
      for (const f of uploadedFiles) fs.unlink(f.path, () => {});
    };
    const cleanupMedia = (paths) => {
      for (const p of paths) fs.unlink(p, () => {});
    };

    const { message, job_id } = req.body ?? {};
    const featuredIndex  = parseInt(req.body.featured_index ?? '0', 10) || 0;
    const businessUrl    = req.body.business_url ?? '';

    if (!message || typeof message !== 'string' || !message.trim()) {
      cleanup();
      return res.status(400).json({ error: 'message is required' });
    }
    if (!job_id || typeof job_id !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'job_id is required' });
    }

    const contentHash = createHash('sha256').update(message).digest('hex');

    const freePubReserved = await tryReserveFreePublication(req.userId, job_id).catch(() => false);
    if (!req.publishIsSubscribed && !freePubReserved) {
      const isRetry = req.publishIsFreeRetry
        ? await checkFreeRetryAllowed(req.userId, job_id).catch(() => false)
        : false;
      if (!isRetry) {
        cleanup();
        return res.status(402).json({
          error: 'SUBSCRIPTION_REQUIRED',
          message: 'Your free post has been used. Start a trial to keep posting.',
        });
      }
    }

    const pool      = getPool();
    const now       = Date.now();
    const serverUrl = process.env.SERVER_URL ?? '';

    // Fetch selected locations
    let selectedLocations;
    try {
      const { rows } = await pool.query(
        `SELECT id, account_id, account_name FROM connected_platforms
         WHERE user_id = $1 AND platform = 'google' AND selected = true
         ORDER BY account_name ASC`,
        [req.userId]
      );
      selectedLocations = rows;
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    if (selectedLocations.length === 0) {
      cleanup();
      return res.status(422).json({
        error: 'no_locations_selected',
        detail: 'No Google Business locations selected. Go to Settings → Connected Accounts.',
      });
    }

    // Order photos and limit to GBP max (10 photos per post)
    const photoFiles = orderWithFeaturedFirst(
      uploadedFiles
        .filter(f => /^photo_\d+$/.test(f.fieldname))
        .sort((a, b) => {
          const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
          const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
          return ai - bi;
        }),
      featuredIndex
    ).slice(0, 10);

    // Copy photos to named tmp files so they can be served via /google/media/:filename.
    // GBP fetches the images from the sourceUrl when processing the post.
    const mediaPaths = [];
    const mediaUrls  = [];
    if (photoFiles.length > 0 && serverUrl) {
      for (let i = 0; i < photoFiles.length; i++) {
        const destName = `gbp_${now}_${i}.jpg`;
        const destPath = path.join(TMP_DIR, destName);
        try {
          fs.copyFileSync(photoFiles[i].path, destPath);
          mediaPaths.push(destPath);
          mediaUrls.push(`${serverUrl}/google/media/${destName}`);
        } catch (err) {
          console.warn('[google] media copy error:', err.message);
        }
      }
    }

    const results = [];

    for (const locRow of selectedLocations) {
      // Stable idempotency key: user + job + location resource path
      const jobRef = `gbp_${req.userId}_${job_id}_${locRow.account_id.replace(/\W+/g, '_')}`;

      // Idempotency: skip if already successfully published
      let alreadyPublished;
      try {
        const { rows } = await pool.query(
          `SELECT id, platform_post_id FROM publishing_records
           WHERE user_id = $1 AND platform = 'google' AND job_ref = $2 AND status = 'published'
           LIMIT 1`,
          [req.userId, jobRef]
        );
        alreadyPublished = rows[0];
      } catch (err) {
        results.push({ locationId: locRow.account_id, locationName: locRow.account_name, ok: false, error: err.message });
        continue;
      }

      if (alreadyPublished) {
        results.push({
          locationId: locRow.account_id, locationName: locRow.account_name,
          ok: true, duplicate: true, postId: alreadyPublished.platform_post_id,
        });
        continue;
      }

      // Retry authorization: for free-slot retries, this location must have a prior attempt record
      // (failed or stuck-pending from a crash), and the content must not have changed.
      if (req.publishIsFreeRetry) {
        try {
          const { rows: priorRecord } = await pool.query(
            `SELECT content_hash FROM publishing_records
             WHERE user_id = $1 AND job_ref = $2 AND status IN ('failed', 'pending')
             ORDER BY created_at DESC LIMIT 1`,
            [req.userId, jobRef]
          );
          if (priorRecord.length === 0) {
            results.push({
              locationId: locRow.account_id,
              locationName: locRow.account_name,
              ok: false,
              error: 'This location was not part of the original post.',
            });
            continue;
          }
          const storedHash = priorRecord[0].content_hash;
          if (storedHash && storedHash !== contentHash) {
            results.push({
              locationId: locRow.account_id,
              locationName: locRow.account_name,
              ok: false,
              error: 'Post content has changed since the original attempt.',
            });
            continue;
          }
        } catch (err) {
          results.push({ locationId: locRow.account_id, locationName: locRow.account_name, ok: false, error: err.message });
          continue;
        }
      }

      let recordId = null;
      const markFailed = async (msg) => {
        if (!recordId) return;
        await pool.query(
          `UPDATE publishing_records SET status = 'failed', error_message = $1, updated_at = $2 WHERE id = $3`,
          [msg, Date.now(), recordId]
        ).catch(() => {});
      };

      try {
        // Get a valid access token (refresh proactively if close to expiry)
        let accessToken;
        try {
          accessToken = await getValidToken(req.userId, pool);
        } catch (authErr) {
          results.push({
            locationId: locRow.account_id, locationName: locRow.account_name,
            ok: false, error: authErr.message, reconnect_required: true,
          });
          continue;
        }

        const { rows: [record] } = await pool.query(
          `INSERT INTO publishing_records (user_id, platform, job_ref, client_job_id, content_hash, status, created_at, updated_at)
           VALUES ($1, 'google', $2, $3, $4, 'pending', $5, $6) RETURNING id`,
          [req.userId, jobRef, job_id, contentHash, now, now]
        );
        recordId = record.id;

        // Build local post body
        const summary = message.trim().slice(0, GBP_SUMMARY_MAX);
        const postBody = {
          languageCode: 'en-US',
          summary,
          topicType: 'STANDARD',
        };

        if (businessUrl) {
          postBody.callToAction = { actionType: 'LEARN_MORE', url: businessUrl };
        }

        if (mediaUrls.length > 0) {
          postBody.media = mediaUrls.map(url => ({ mediaFormat: 'PHOTO', sourceUrl: url }));
        }

        const locationPath = locRow.account_id; // accounts/{X}/locations/{Y}
        const apiUrl = `${LOCAL_POSTS_API}/${locationPath}/localPosts`;

        let postResp = await apiFetch(apiUrl, {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(postBody),
        });

        // On 401, refresh once and retry
        if (postResp.status === 401) {
          try {
            accessToken = await _doRefresh(req.userId, pool);
            postResp = await apiFetch(apiUrl, {
              method: 'POST',
              headers: {
                Authorization:  `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(postBody),
            });
          } catch (refreshErr) {
            throw Object.assign(new Error(refreshErr.message), { isAuthError: true });
          }
        }

        const postData = await postResp.json();

        if (postData.error) {
          const isAuth = postResp.status === 401 || postData.error.status === 'UNAUTHENTICATED';
          throw Object.assign(
            new Error(`GBP: ${postData.error.message ?? JSON.stringify(postData.error)}`),
            { isGbpError: true, isAuthError: isAuth }
          );
        }

        const postId   = postData.name ?? '';   // accounts/X/locations/Y/localPosts/Z
        const postLink = postData.searchUrl ?? null;

        await pool.query(
          `UPDATE publishing_records
           SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
           WHERE id = $4`,
          [postId, now, now, recordId]
        );

        results.push({
          locationId: locRow.account_id, locationName: locRow.account_name,
          ok: true, postId, postUrl: postLink,
        });
      } catch (err) {
        console.error('[google] publish error for', locRow.account_name, ':', err.message);
        await markFailed(err.message);
        results.push({
          locationId:         locRow.account_id,
          locationName:       locRow.account_name,
          ok:                 false,
          error:              err.message,
          reconnect_required: err.isAuthError ?? false,
        });
      }
    }

    cleanupMedia(mediaPaths);
    cleanup();

    const anyOk = results.some(r => r.ok);

    if (freePubReserved) {
      if (anyOk) {
        const wasFirst = await redeemFreePublication(req.userId, job_id, req.headers['x-devicecheck-token']).catch(() => false);
        if (wasFirst) trackFreePublicationCompleted(req.userId, { platform: 'google' });
      } else {
        await releaseFreePublicationIfNoSuccess(req.userId, job_id).catch(() => {});
      }
    }
    trackPublicationResult(req.userId, results, 'google');

    return res.status(200).json({ ok: anyOk, results });
  });

  return router;
}

module.exports = { createGoogleRouter };
