'use strict';

const { Router } = require('express');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const multer     = require('multer');

const { getPool }          = require('../db');
const { requireAuth }      = require('../auth');
const { tryReserveFreePublication, redeemFreePublication, releaseFreePublicationIfNoSuccess, checkFreeRetryAllowed } = require('./billing');
const { trackFreePublicationCompleted, trackPublicationResult } = require('../services/analytics');
const { encrypt, decrypt } = require('../crypto');
const {
  orderWithFeaturedFirst,
  prepareForInstagram,
  prepareCarouselForInstagram,
  generateBeforeAfterComposite,
} = require('./media-utils');

const THREADS_AUTHORIZE_URL      = 'https://threads.net/oauth/authorize';
const THREADS_TOKEN_URL          = 'https://graph.threads.net/oauth/access_token';
const THREADS_GRAPH_BASE         = 'https://graph.threads.net';
const THREADS_API_VERSION        = 'v1.0';
const THREADS_PERMISSIONS        = 'threads_basic,threads_content_publish';
const OAUTH_STATE_TTL_MS         = 10 * 60 * 1000;
const MAX_CAROUSEL               = 20;
const CONTAINER_POLL_INITIAL_DELAY_MS  = 2000;
const CONTAINER_POLL_MAX_DELAY_MS      = 10000;
const CONTAINER_POLL_MAX_ATTEMPTS      = 15;
const CAROUSEL_PUBLISH_MAX_RETRIES     = 3;
const CAROUSEL_PUBLISH_RETRY_DELAY_MS  = 5000;

// Polls a Threads media container until status is FINISHED (or ERROR/EXPIRED).
// Uses exponential backoff starting at initialDelayMs, capped at maxDelayMs.
// opts: { maxAttempts, initialDelayMs, maxDelayMs } — injectable for tests.
async function waitForThreadsContainer(containerId, token, threadsFetch, opts = {}) {
  const maxAttempts    = opts.maxAttempts    ?? CONTAINER_POLL_MAX_ATTEMPTS;
  const initialDelayMs = opts.initialDelayMs ?? CONTAINER_POLL_INITIAL_DELAY_MS;
  const maxDelayMs     = opts.maxDelayMs     ?? CONTAINER_POLL_MAX_DELAY_MS;
  const startMs        = Date.now();
  let delay            = initialDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, maxDelayMs);

    const data = await threadsFetch(
      `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${containerId}?fields=id,status,error_message&access_token=${token}`
    ).then(r => r.json());

    if (data.error) {
      throw Object.assign(new Error(data.error.message), { isRevoked: data.error.code === 190 });
    }
    console.log(
      `[threads] container ${containerId} poll #${attempt}:`,
      `status=${data.status ?? 'unknown'}`,
      data.error_message ? `error_msg=${data.error_message}` : '',
      `elapsed=${Date.now() - startMs}ms`
    );
    if (data.status === 'FINISHED') return;
    if (data.status === 'ERROR')    throw new Error(`Threads container ${containerId} processing failed: ${data.error_message ?? 'unknown'}`);
    if (data.status === 'EXPIRED')  throw new Error(`Threads container ${containerId} expired before publishing.`);
    // IN_PROGRESS or unrecognised status — keep polling
  }
  throw new Error(`Threads container ${containerId} timed out after ${maxAttempts} attempts (${Date.now() - startMs}ms).`);
}

function parseIntArray(v) {
  if (!v) return null;
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

// Validate Meta's signed_request (base64url_sig.base64url_payload, HMAC-SHA256)
function validateSignedRequest(signedRequest, appSecret) {
  if (typeof signedRequest !== 'string') return null;
  const dotIdx = signedRequest.indexOf('.');
  if (dotIdx < 0) return null;
  const encodedSig     = signedRequest.slice(0, dotIdx);
  const encodedPayload = signedRequest.slice(dotIdx + 1);

  const toBuffer = (b64url) =>
    Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  const sig     = toBuffer(encodedSig);
  const payload = toBuffer(encodedPayload);
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();

  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try { return JSON.parse(payload.toString('utf8')); } catch { return null; }
}

function createThreadsRouter({
  threadsFetch        = (...args) => fetch(...args),
  publishRetryDelayMs = CAROUSEL_PUBLISH_RETRY_DELAY_MS,
  containerPollOpts   = {},
} = {}) {
  const TMP_DIR   = path.join(__dirname, '..', 'tmp');
  const MEDIA_DIR = path.join(TMP_DIR, 'threads-media');
  if (!fs.existsSync(TMP_DIR))   fs.mkdirSync(TMP_DIR,   { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const upload = multer({ dest: TMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });
  const router = Router();

  // ── GET /threads/media/:filename ────────────────────────────────────────────
  // Public — Threads API fetches prepared images from here during container creation
  router.get('/media/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^[a-f0-9-]+\.(jpg|jpeg|png)$/i.test(filename)) {
      return res.status(404).send('Not found');
    }
    const fp = path.join(MEDIA_DIR, filename);
    if (!fs.existsSync(fp)) return res.status(404).send('Not found');
    res.sendFile(fp);
  });

  // ── POST /threads/connect-url ────────────────────────────────────────────────
  router.post('/connect-url', requireAuth, async (req, res, next) => {
    try {
      const appId       = process.env.THREADS_APP_ID       ?? '';
      const redirectUri = process.env.THREADS_REDIRECT_URI ?? '';

      if (!appId || !redirectUri) {
        return res.status(503).json({ error: 'Threads integration not configured on this server' });
      }

      const state = crypto.randomBytes(24).toString('hex');
      const now   = Date.now();

      await getPool().query(
        `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
         VALUES ($1, $2, 'threads', $3, $4)`,
        [state, req.userId, now, now + OAUTH_STATE_TTL_MS]
      );

      const params = new URLSearchParams({
        client_id:     appId,
        redirect_uri:  redirectUri,
        scope:         THREADS_PERMISSIONS,
        response_type: 'code',
        state,
      });

      return res.json({ authUrl: `${THREADS_AUTHORIZE_URL}?${params}` });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /threads/callback ────────────────────────────────────────────────────
  router.get('/callback', async (req, res) => {
    const appId        = process.env.THREADS_APP_ID              ?? '';
    const appSecret    = process.env.THREADS_APP_SECRET          ?? '';
    const redirectUri  = process.env.THREADS_REDIRECT_URI        ?? '';
    const returnScheme = process.env.FACEBOOK_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase   = `${returnScheme}://oauth/callback`;

    const { code, state, error: threadsError } = req.query;
    console.log('[threads] callback — code:', !!code, '| state:', !!state, '| error:', threadsError ?? 'none');

    if (threadsError) {
      return res.redirect(`${returnBase}?platform=threads&error=${encodeURIComponent(String(threadsError))}`);
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return res.redirect(`${returnBase}?platform=threads&error=missing_params`);
    }

    if (!appId || !appSecret || !redirectUri) {
      return res.redirect(`${returnBase}?platform=threads&error=server_not_configured`);
    }

    try {
      const pool = getPool();
      const now  = Date.now();

      // Atomically validate and consume the state token
      const client = await pool.connect();
      let stateRow;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT id, user_id, expires_at, used_at
           FROM oauth_states WHERE state = $1 AND platform = 'threads'
           FOR UPDATE`,
          [state]
        );
        stateRow = rows[0];

        if (!stateRow) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=threads&error=invalid_state`);
        }
        if (stateRow.used_at) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=threads&error=state_already_used`);
        }
        if (stateRow.expires_at < now) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=threads&error=state_expired`);
        }

        await client.query('UPDATE oauth_states SET used_at = $1 WHERE id = $2', [now, stateRow.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Step 1 — Exchange code for short-lived token
      const tokenForm = new URLSearchParams({
        client_id:     appId,
        client_secret: appSecret,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
        code,
      });
      const tokenData = await threadsFetch(THREADS_TOKEN_URL, { method: 'POST', body: tokenForm })
        .then(r => r.json());

      if (tokenData.error_type || tokenData.error_message || tokenData.error) {
        throw new Error(`Token exchange: ${tokenData.error_message ?? tokenData.error?.message ?? tokenData.error_type}`);
      }

      const shortToken = tokenData.access_token;

      // Step 2 — Exchange for long-lived token (~60 days)
      const longParams = new URLSearchParams({
        grant_type:    'th_exchange_token',
        client_secret: appSecret,
        access_token:  shortToken,
      });
      const longData = await threadsFetch(`${THREADS_GRAPH_BASE}/access_token?${longParams}`)
        .then(r => r.json());

      if (longData.error) {
        throw new Error(`Long-lived token: ${longData.error.message ?? JSON.stringify(longData.error)}`);
      }

      const longToken = longData.access_token;
      const expiresMs = (longData.expires_in ?? 5184000) * 1000;

      // Step 3 — Fetch profile
      const profileParams = new URLSearchParams({
        fields:       'id,name,username',
        access_token: longToken,
      });
      const profileData = await threadsFetch(
        `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/me?${profileParams}`
      ).then(r => r.json());

      if (profileData.error) {
        throw new Error(`Profile: ${profileData.error.message}`);
      }

      const threadsUserId = String(profileData.id);
      const accountName   = profileData.name || profileData.username || `Threads ${threadsUserId}`;
      const tokenEnc      = encrypt(longToken);

      await pool.query(
        `INSERT INTO connected_platforms
           (user_id, platform, account_name, account_id, access_token_enc,
            token_expires_at, selected, connected_at, updated_at)
         VALUES ($1, 'threads', $2, $3, $4, $5, true, $6, $7)
         ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
           account_name     = EXCLUDED.account_name,
           access_token_enc = EXCLUDED.access_token_enc,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at       = EXCLUDED.updated_at`,
        [stateRow.user_id, accountName, threadsUserId, tokenEnc, now + expiresMs, now, now]
      );

      return res.redirect(`${returnBase}?platform=threads&success=true`);

    } catch (err) {
      console.error('[threads] callback error:', err.message);
      return res.redirect(`${returnBase}?platform=threads&error=auth_failed`);
    }
  });

  // ── GET /threads/account ─────────────────────────────────────────────────────
  router.get('/account', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await getPool().query(
        `SELECT id, account_name, account_id, token_expires_at, connected_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'threads'
         ORDER BY connected_at DESC LIMIT 1`,
        [req.userId]
      );
      return res.json({ account: rows[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /threads/publish ────────────────────────────────────────────────────
  // Accepts multipart: text (string), job_id (string), photo_0..N (files),
  // featured_index (optional integer), classifications (optional JSON array).
  // No photos → text-only post. With photos → image or carousel post.
  router.post('/publish', requireAuth, upload.any(), async (req, res) => {
    const uploadedFiles  = req.files ?? [];
    const processedFiles = [];
    let compositePath    = null;

    const cleanup = () => {
      for (const f of uploadedFiles)   fs.unlink(f.path,   () => {});
      for (const fp of processedFiles) fs.unlink(fp,       () => {});
      if (compositePath)               fs.unlink(compositePath, () => {});
    };

    const { text, job_id } = req.body ?? {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      cleanup();
      return res.status(400).json({ error: 'text is required' });
    }
    if (!job_id || typeof job_id !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'job_id is required' });
    }

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

    const featuredIndex   = parseInt(req.body.featured_index ?? '0', 10) || 0;
    const classifications = parseIntArray(req.body.classifications) ?? [];

    const pool      = getPool();
    const now       = Date.now();
    const serverUrl = process.env.SERVER_URL ?? 'https://api.getelmer.com';

    // Fetch Threads account
    let thAccount;
    try {
      const { rows } = await pool.query(
        `SELECT id, account_id, account_name, access_token_enc, token_expires_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'threads'
         LIMIT 1`,
        [req.userId]
      );
      thAccount = rows[0];
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    if (!thAccount) {
      cleanup();
      return res.status(422).json({ error: 'no_threads_account', detail: 'No Threads account connected.' });
    }

    if (thAccount.token_expires_at && thAccount.token_expires_at < now) {
      cleanup();
      return res.status(422).json({ error: 'token_expired', detail: 'Threads access token has expired. Reconnect in Settings.' });
    }

    let thToken;
    try {
      thToken = decrypt(thAccount.access_token_enc);
    } catch {
      cleanup();
      return res.status(500).json({ error: 'Could not read Threads credentials.' });
    }

    const thUserId = thAccount.account_id;

    // Sort photo files by field name
    let photoFiles = uploadedFiles
      .filter(f => /^photo_\d+$/.test(f.fieldname))
      .sort((a, b) => {
        const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
        const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
        return ai - bi;
      });

    // Idempotency check
    const jobRef = `th_${req.userId}_${job_id}`;
    try {
      const { rows } = await pool.query(
        `SELECT id, platform_post_id
         FROM publishing_records
         WHERE user_id = $1 AND platform = 'threads' AND job_ref = $2 AND status = 'published'
         LIMIT 1`,
        [req.userId, jobRef]
      );
      if (rows[0]) {
        cleanup();
        const postId  = rows[0].platform_post_id;
        const plData  = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${postId}?fields=permalink&access_token=${thToken}`
        ).then(r => r.json()).catch(() => ({}));
        return res.json({
          ok:          true,
          duplicate:   true,
          accountId:   thUserId,
          accountName: thAccount.account_name,
          postId,
          postUrl:     plData.permalink || `https://www.threads.net/t/${postId}`,
        });
      }
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    // Retry authorization: for free-slot retries, this destination must have a prior failed record.
    if (req.publishIsFreeRetry) {
      try {
        const { rows: priorFailed } = await pool.query(
          `SELECT 1 FROM publishing_records
           WHERE user_id = $1 AND job_ref = $2 AND status = 'failed' LIMIT 1`,
          [req.userId, jobRef]
        );
        if (priorFailed.length === 0) {
          cleanup();
          return res.status(402).json({
            error: 'SUBSCRIPTION_REQUIRED',
            message: 'This destination was not part of the original post.',
          });
        }
      } catch (err) {
        cleanup();
        return res.status(500).json({ error: 'Database error', detail: err.message });
      }
    }

    // Insert pending publishing record
    const { rows: [record] } = await pool.query(
      `INSERT INTO publishing_records
         (user_id, platform, job_ref, client_job_id, status, created_at, updated_at)
       VALUES ($1, 'threads', $2, $3, 'pending', $4, $5) RETURNING id`,
      [req.userId, jobRef, job_id, now, now]
    );
    const recordId = record.id;

    const markFailed = async (msg) => {
      await pool.query(
        `UPDATE publishing_records SET status = 'failed', error_message = $1, updated_at = $2 WHERE id = $3`,
        [msg, Date.now(), recordId]
      ).catch(() => {});
    };

    // ── Text-only post ──────────────────────────────────────────────────────────
    if (photoFiles.length === 0) {
      try {
        const cData = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads`,
          {
            method: 'POST',
            body: new URLSearchParams({
              media_type:   'TEXT',
              text:         text.trim(),
              access_token: thToken,
            }),
          }
        ).then(r => r.json());

        if (cData.error) {
          console.error('[threads] text container error:', JSON.stringify(cData.error));
          throw Object.assign(new Error(cData.error.message), { isRevoked: cData.error.code === 190 });
        }

        const pData = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads_publish`,
          {
            method: 'POST',
            body: new URLSearchParams({ creation_id: cData.id, access_token: thToken }),
          }
        ).then(r => r.json());

        if (pData.error) {
          console.error('[threads] text publish error:', JSON.stringify(pData.error));
          throw Object.assign(new Error(pData.error.message), { isRevoked: pData.error.code === 190 });
        }

        const postId  = pData.id;
        const postUrl = `https://www.threads.net/t/${postId}`;

        await pool.query(
          `UPDATE publishing_records
           SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
           WHERE id = $4`,
          [postId, now, now, recordId]
        );

        return res.json({ ok: true, accountId: thUserId, accountName: thAccount.account_name, postId, postUrl });

      } catch (err) {
        console.error('[threads] text publish error:', err.message);
        await markFailed(err.message);
        return res.json({
          ok: false, accountId: thUserId, accountName: thAccount.account_name,
          error: err.message, reconnect_required: err.isRevoked ?? false,
        });
      }
    }

    // ── Image / carousel post ───────────────────────────────────────────────────

    // Move featured photo to front
    photoFiles = orderWithFeaturedFirst(photoFiles, featuredIndex);

    // Generate before/after composite if applicable
    const classMap = {};
    photoFiles.forEach((f, i) => {
      const cls = classifications[i] ?? 'General';
      classMap[cls] = classMap[cls] ?? [];
      classMap[cls].push(f);
    });

    const beforeFiles    = classMap['Before'] ?? [];
    const afterFiles     = classMap['After']  ?? [];
    const hasCompletePair = beforeFiles.length > 0 && afterFiles.length > 0;

    if (hasCompletePair) {
      try {
        compositePath = await generateBeforeAfterComposite(
          beforeFiles[0].path,
          afterFiles[0].path,
          MEDIA_DIR
        );
        const otherFiles = photoFiles.filter((_, i) => {
          const cls = classifications[i] ?? 'General';
          return cls !== 'Before' && cls !== 'After';
        });
        photoFiles = [{ path: compositePath, mimetype: 'image/jpeg' }, ...otherFiles];
      } catch (err) {
        console.warn('[threads] composite generation failed, using original photos:', err.message);
        compositePath = null;
      }
    }

    photoFiles = photoFiles.slice(0, MAX_CAROUSEL);

    // Prepare images — reuse Instagram preparation (same aspect ratio requirements)
    let preparedPaths;
    if (photoFiles.length === 1) {
      try {
        const prepared = await prepareForInstagram(photoFiles[0].path);
        if (prepared !== photoFiles[0].path) processedFiles.push(prepared);
        preparedPaths = [prepared];
      } catch (err) {
        console.warn('[threads] image preparation failed, using original:', err.message);
        preparedPaths = [photoFiles[0].path];
      }
    } else {
      try {
        const prepared = await prepareCarouselForInstagram(photoFiles.map(f => f.path));
        prepared.forEach((p, i) => { if (p !== photoFiles[i].path) processedFiles.push(p); });
        preparedPaths = prepared;
      } catch (err) {
        console.warn('[threads] carousel preparation failed, using originals:', err.message);
        preparedPaths = photoFiles.map(f => f.path);
      }
    }

    // Stage images in public MEDIA_DIR so Threads API can fetch them
    const mediaItems = [];
    for (const preparedPath of preparedPaths) {
      const uuid     = crypto.randomBytes(16).toString('hex');
      const filename = `${uuid}.jpg`;
      const destPath = path.join(MEDIA_DIR, filename);
      try {
        fs.copyFileSync(preparedPath, destPath);
      } catch {
        cleanup();
        return res.status(500).json({ error: 'Failed to stage media file.' });
      }
      mediaItems.push({ publicUrl: `${serverUrl}/threads/media/${filename}`, stagedPath: destPath });
    }

    const cleanupMedia = () => mediaItems.forEach(m => fs.unlink(m.stagedPath, () => {}));

    try {
      let postId;

      if (mediaItems.length === 1) {
        // Single image
        const cData = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads`,
          {
            method: 'POST',
            body: new URLSearchParams({
              media_type:   'IMAGE',
              image_url:    mediaItems[0].publicUrl,
              text:         text.trim(),
              access_token: thToken,
            }),
          }
        ).then(r => r.json());

        if (cData.error) {
          console.error('[threads] image container error:', JSON.stringify(cData.error));
          throw Object.assign(new Error(cData.error.message), { isRevoked: cData.error.code === 190 });
        }
        await waitForThreadsContainer(cData.id, thToken, threadsFetch, containerPollOpts);
        cleanupMedia();

        const pData = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads_publish`,
          {
            method: 'POST',
            body: new URLSearchParams({ creation_id: cData.id, access_token: thToken }),
          }
        ).then(r => r.json());

        if (pData.error) {
          console.error('[threads] image publish error:', JSON.stringify(pData.error));
          throw Object.assign(new Error(pData.error.message), { isRevoked: pData.error.code === 190 });
        }
        postId = pData.id;

      } else {
        // Carousel: create all child containers in parallel, wait for all to reach FINISHED,
        // then assemble and publish. Staged files are kept until after the carousel container
        // is FINISHED — the Threads pipeline may re-access image URLs during processing.
        const childDatas = await Promise.all(mediaItems.map(async (item) => {
          const cData = await threadsFetch(
            `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads`,
            {
              method: 'POST',
              body: new URLSearchParams({
                media_type:       'IMAGE',
                image_url:        item.publicUrl,
                is_carousel_item: 'true',
                access_token:     thToken,
              }),
            }
          ).then(r => r.json());

          if (cData.error) {
            console.error('[threads] carousel child create error:', JSON.stringify(cData.error));
            throw Object.assign(new Error(cData.error.message), { isRevoked: cData.error.code === 190 });
          }
          console.log(`[threads] carousel child created: id=${cData.id}`);
          return { id: cData.id, stagedPath: item.stagedPath };
        }));

        // Wait for all children concurrently. Files remain staged (publicly accessible).
        await Promise.all(childDatas.map(({ id }) =>
          waitForThreadsContainer(id, thToken, threadsFetch, containerPollOpts)
        ));

        const childIds = childDatas.map(d => d.id);
        console.log(`[threads] carousel children FINISHED: ids=${childIds.join(',')}`);

        const carData = await threadsFetch(
          `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads`,
          {
            method: 'POST',
            body: new URLSearchParams({
              media_type:   'CAROUSEL',
              children:     childIds.join(','),
              text:         text.trim(),
              access_token: thToken,
            }),
          }
        ).then(r => r.json());

        if (carData.error) {
          console.error('[threads] carousel container error:', JSON.stringify(carData.error));
          throw Object.assign(new Error(carData.error.message), { isRevoked: carData.error.code === 190 });
        }
        console.log(`[threads] carousel container created: id=${carData.id}`);

        await waitForThreadsContainer(carData.id, thToken, threadsFetch, containerPollOpts);
        console.log(`[threads] carousel container FINISHED: id=${carData.id}`);

        // Staged files no longer needed — release them before publishing.
        cleanupMedia();

        // Publish with bounded retry on 4279009 (Threads API propagation delay after FINISHED).
        // On each retry, re-verify the container is still FINISHED before retrying.
        let pData;
        for (let attempt = 0; attempt < CAROUSEL_PUBLISH_MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            const checkData = await threadsFetch(
              `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${carData.id}?fields=id,status,error_message&access_token=${thToken}`
            ).then(r => r.json());
            const recheckStatus = checkData.status ?? 'unknown';
            console.log(`[threads] carousel container ${carData.id} recheck #${attempt}: status=${recheckStatus}${checkData.error_message ? ' msg=' + checkData.error_message : ''}`);
            if (recheckStatus === 'ERROR' || recheckStatus === 'EXPIRED') {
              throw new Error(`Carousel container ${recheckStatus} during publish retry: ${checkData.error_message ?? recheckStatus}`);
            }
            await new Promise(r => setTimeout(r, publishRetryDelayMs));
          }

          pData = await threadsFetch(
            `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${thUserId}/threads_publish`,
            {
              method: 'POST',
              body: new URLSearchParams({ creation_id: carData.id, access_token: thToken }),
            }
          ).then(r => r.json());

          console.log(
            `[threads] carousel publish attempt ${attempt + 1}:`,
            pData.error
              ? `error code=${pData.error.code} subcode=${pData.error.error_subcode} reused_container=${attempt > 0}`
              : `ok id=${pData.id}`
          );

          if (!pData.error) break;
          if (pData.error.error_subcode !== 4279009) break;  // only retry on media-not-found
        }

        if (pData.error) {
          console.error('[threads] carousel publish error:', JSON.stringify(pData.error));
          throw Object.assign(new Error(pData.error.message), { isRevoked: pData.error.code === 190 });
        }
        postId = pData.id;
      }

      const plData = await threadsFetch(
        `${THREADS_GRAPH_BASE}/${THREADS_API_VERSION}/${postId}?fields=permalink&access_token=${thToken}`
      ).then(r => r.json()).catch(() => ({}));
      const postUrl = plData.permalink || `https://www.threads.net/t/${postId}`;

      await pool.query(
        `UPDATE publishing_records
         SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
         WHERE id = $4`,
        [postId, now, now, recordId]
      );

      cleanup();
      if (freePubReserved) {
        const wasFirst = await redeemFreePublication(req.userId, job_id, req.headers['x-devicecheck-token']).catch(() => false);
        if (wasFirst) trackFreePublicationCompleted(req.userId, { platform: 'threads' });
      }
      trackPublicationResult(req.userId, [{ ok: true }], 'threads');
      return res.json({ ok: true, accountId: thUserId, accountName: thAccount.account_name, postId, postUrl });

    } catch (err) {
      console.error('[threads] publish error:', err.message);
      await markFailed(err.message);
      cleanupMedia();
      cleanup();
      if (freePubReserved) await releaseFreePublicationIfNoSuccess(req.userId, job_id).catch(() => {});
      trackPublicationResult(req.userId, [{ ok: false }], 'threads');
      return res.json({
        ok: false, accountId: thUserId, accountName: thAccount.account_name,
        error: err.message, reconnect_required: err.isRevoked ?? false,
      });
    }
  });

  // ── POST /threads/uninstall ──────────────────────────────────────────────────
  // Meta sends this when a user deauthorizes the app.
  // Validates signed_request, removes the Threads platform connection.
  router.post('/uninstall', async (req, res) => {
    const appSecret = process.env.THREADS_APP_SECRET ?? '';
    if (!appSecret) return res.status(503).json({ error: 'Not configured' });

    const payload = validateSignedRequest(req.body?.signed_request, appSecret);
    if (!payload) {
      console.warn('[threads] uninstall: invalid signed_request');
      return res.status(400).json({ error: 'Invalid signed_request' });
    }

    const threadsUserId = String(payload.user_id ?? '');
    if (threadsUserId) {
      try {
        await getPool().query(
          `DELETE FROM connected_platforms WHERE platform = 'threads' AND account_id = $1`,
          [threadsUserId]
        );
        console.log('[threads] uninstall: removed connection for Threads user', threadsUserId);
      } catch (err) {
        console.error('[threads] uninstall DB error:', err.message);
      }
    }

    return res.sendStatus(200);
  });

  // ── POST /threads/delete ─────────────────────────────────────────────────────
  // Meta data deletion callback.
  // Validates signed_request, deletes all Threads-associated data,
  // returns the JSON confirmation required by Meta.
  router.post('/delete', async (req, res) => {
    const appSecret = process.env.THREADS_APP_SECRET ?? '';
    if (!appSecret) return res.status(503).json({ error: 'Not configured' });

    const payload = validateSignedRequest(req.body?.signed_request, appSecret);
    if (!payload) {
      console.warn('[threads] delete: invalid signed_request');
      return res.status(400).json({ error: 'Invalid signed_request' });
    }

    const threadsUserId    = String(payload.user_id ?? '');
    const confirmationCode = crypto.randomBytes(8).toString('hex');

    if (threadsUserId) {
      try {
        await getPool().query(
          `DELETE FROM connected_platforms WHERE platform = 'threads' AND account_id = $1`,
          [threadsUserId]
        );
        console.log('[threads] delete: removed Threads data for user', threadsUserId);
      } catch (err) {
        console.error('[threads] delete DB error:', err.message);
      }
    }

    const serverUrl = process.env.SERVER_URL ?? 'https://api.getelmer.com';
    return res.json({
      url:               `${serverUrl}/threads/deletion-status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  });

  // ── GET /threads/deletion-status ─────────────────────────────────────────────
  // Human-readable status page referenced in the data deletion response.
  router.get('/deletion-status', (_req, res) => {
    res.type('html').send(
      '<html><body><h1>Threads Data Deletion</h1>' +
      '<p>Your Threads connection and associated data have been removed from Elmer.</p>' +
      '</body></html>'
    );
  });

  return router;
}

module.exports = { createThreadsRouter };
