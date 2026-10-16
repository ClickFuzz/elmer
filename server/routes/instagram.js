'use strict';

const { Router }      = require('express');
const { randomBytes } = require('crypto');
const fs              = require('fs');
const path            = require('path');
const multer          = require('multer');
const { getPool }     = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { requireAuth } = require('../auth');
const {
  prepareForInstagram,
  prepareCarouselForInstagram,
  generateBeforeAfterComposite,
  orderWithFeaturedFirst,
  parseIntArray,
} = require('./media-utils');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const IG_AUTHORIZE_URL   = 'https://api.instagram.com/oauth/authorize';
const IG_TOKEN_URL       = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_BASE      = 'https://graph.instagram.com';
const IG_API_VERSION     = 'v21.0';
const IG_PERMISSIONS     = 'instagram_business_basic,instagram_business_content_publish';
const MAX_CAROUSEL       = 10;
const CONTAINER_POLL_INTERVAL_MS = 3000; // 3 s between status checks
const CONTAINER_POLL_MAX_ATTEMPTS = 15;  // up to ~45 s total

// Polls a media container until status_code is FINISHED (or ERROR/EXPIRED).
// Throws if the container errors, expires, or the timeout is reached.
async function waitForContainer(containerId, token, igFetch) {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, CONTAINER_POLL_INTERVAL_MS));
    }
    const data = await igFetch(
      `${IG_GRAPH_BASE}/${IG_API_VERSION}/${containerId}?fields=status_code&access_token=${token}`
    ).then(r => r.json());

    if (data.error) {
      throw Object.assign(new Error(data.error.message), { isIgError: true, igCode: data.error.code });
    }
    const status = data.status_code;
    if (status === 'FINISHED') return;
    if (status === 'ERROR')    throw new Error('Instagram media container processing failed.');
    if (status === 'EXPIRED')  throw new Error('Instagram media container expired before publishing.');
    // IN_PROGRESS or unknown — keep polling
  }
  throw new Error('Instagram media container timed out waiting for FINISHED status.');
}

function createInstagramRouter({ igFetch = (...args) => fetch(...args) } = {}) {
  const TMP_DIR   = path.join(__dirname, '..', 'tmp');
  const MEDIA_DIR = path.join(TMP_DIR, 'instagram-media');
  if (!fs.existsSync(TMP_DIR))   fs.mkdirSync(TMP_DIR,   { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const upload = multer({ dest: TMP_DIR });
  const router = Router();

  // ── GET /instagram/media/:filename ─────────────────────────────────────────
  // Public endpoint — Instagram API fetches images from here during container creation
  router.get('/media/:filename', (req, res) => {
    const { filename } = req.params;
    if (!/^[a-f0-9-]+\.(jpg|jpeg|png)$/i.test(filename)) {
      return res.status(404).send('Not found');
    }
    const fp = path.join(MEDIA_DIR, filename);
    if (!fs.existsSync(fp)) return res.status(404).send('Not found');
    res.sendFile(fp);
  });

  // ── POST /instagram/connect-url ─────────────────────────────────────────────
  router.post('/connect-url', requireAuth, async (req, res, next) => {
    try {
      const appId       = process.env.INSTAGRAM_APP_ID       ?? '';
      const redirectUri = process.env.INSTAGRAM_REDIRECT_URI ?? '';

      if (!appId || !redirectUri) {
        return res.status(503).json({ error: 'Instagram integration not configured on this server' });
      }

      const state = randomBytes(24).toString('hex');
      const now   = Date.now();

      await getPool().query(
        `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
         VALUES ($1, $2, 'instagram', $3, $4)`,
        [state, req.userId, now, now + OAUTH_STATE_TTL_MS]
      );

      const params = new URLSearchParams({
        client_id:     appId,
        redirect_uri:  redirectUri,
        scope:         IG_PERMISSIONS,
        response_type: 'code',
        state,
      });

      return res.json({ authUrl: `${IG_AUTHORIZE_URL}?${params}` });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /instagram/callback ─────────────────────────────────────────────────
  router.get('/callback', async (req, res) => {
    const appId        = process.env.INSTAGRAM_APP_ID             ?? '';
    const appSecret    = process.env.INSTAGRAM_APP_SECRET        ?? '';
    const redirectUri  = process.env.INSTAGRAM_REDIRECT_URI      ?? '';
    const returnScheme = process.env.FACEBOOK_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase   = `${returnScheme}://oauth/callback`;

    const { code, state, error: igError } = req.query;
    console.log('[instagram] callback — code:', !!code, '| state:', !!state, '| error:', igError ?? 'none');

    if (igError) {
      return res.redirect(`${returnBase}?platform=instagram&error=${encodeURIComponent(String(igError))}`);
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return res.redirect(`${returnBase}?platform=instagram&error=missing_params`);
    }

    if (!appId || !appSecret || !redirectUri) {
      return res.redirect(`${returnBase}?platform=instagram&error=server_not_configured`);
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
           FROM oauth_states WHERE state = $1 AND platform = 'instagram'
           FOR UPDATE`,
          [state]
        );
        stateRow = rows[0];

        if (!stateRow) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=instagram&error=invalid_state`);
        }
        if (stateRow.used_at) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=instagram&error=state_already_used`);
        }
        if (stateRow.expires_at < now) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=instagram&error=state_expired`);
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
      const tokenData = await igFetch(IG_TOKEN_URL, { method: 'POST', body: tokenForm })
        .then(r => r.json());

      if (tokenData.error_type || tokenData.error_message) {
        throw new Error(`Token exchange: ${tokenData.error_message ?? tokenData.error_type}`);
      }

      const shortToken = tokenData.access_token;

      // Step 2 — Exchange for long-lived token (~60 days)
      const longParams = new URLSearchParams({
        grant_type:   'ig_exchange_token',
        client_id:    appId,
        client_secret: appSecret,
        access_token: shortToken,
      });
      const longData = await igFetch(`${IG_GRAPH_BASE}/access_token?${longParams}`)
        .then(r => r.json());

      if (longData.error) {
        throw new Error(`Long-lived token: ${longData.error.message}`);
      }

      const longToken  = longData.access_token;
      const expiresMs  = (longData.expires_in ?? 5184000) * 1000;

      // Step 3 — Fetch profile via /me
      const profileParams = new URLSearchParams({
        fields:       'id,name,username,account_type',
        access_token: longToken,
      });
      const profileUrl  = `${IG_GRAPH_BASE}/me?${profileParams}`;
      const profileResp = await igFetch(profileUrl);
      const profileData = await profileResp.json();

      if (profileData.error) {
        console.error('[instagram] profile fetch failed — status:', profileResp.status,
          '| code:', profileData.error.code, '| type:', profileData.error.type,
          '| message:', profileData.error.message);
        throw new Error(`Profile: ${profileData.error.message}`);
      }

      const igUserId = String(profileData.id);

      const accountType = profileData.account_type;
      if (accountType !== 'BUSINESS' && accountType !== 'CREATOR') {
        return res.redirect(`${returnBase}?platform=instagram&error=personal_account_not_supported`);
      }

      const accountName = profileData.name || profileData.username || `Instagram ${igUserId}`;
      const tokenEnc    = encrypt(longToken);

      await pool.query(
        `INSERT INTO connected_platforms
           (user_id, platform, account_name, account_id, access_token_enc,
            token_expires_at, selected, connected_at, updated_at)
         VALUES ($1, 'instagram', $2, $3, $4, $5, true, $6, $7)
         ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
           account_name     = EXCLUDED.account_name,
           access_token_enc = EXCLUDED.access_token_enc,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at       = EXCLUDED.updated_at`,
        [stateRow.user_id, accountName, igUserId, tokenEnc, now + expiresMs, now, now]
      );

      return res.redirect(`${returnBase}?platform=instagram&success=true`);

    } catch (err) {
      console.error('[instagram] callback error:', err.message);
      const code = err.isPermissionError ? 'insufficient_permissions' : 'auth_failed';
      return res.redirect(`${returnBase}?platform=instagram&error=${code}`);
    }
  });

  // ── GET /instagram/account ──────────────────────────────────────────────────
  router.get('/account', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await getPool().query(
        `SELECT id, account_name, account_id, token_expires_at, connected_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'instagram'
         ORDER BY connected_at DESC LIMIT 1`,
        [req.userId]
      );
      return res.json({ account: rows[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /instagram/publish ──────────────────────────────────────────────────
  // Accepts multipart: caption (text), job_id (text), photo_0..N (files),
  // featured_index (optional integer), classifications (optional JSON array).
  router.post('/publish', requireAuth, upload.any(), async (req, res) => {
    const uploadedFiles = req.files ?? [];
    const processedFiles = []; // IG-prepared files to delete after use
    let compositePath = null;  // composite file to delete after use

    const cleanup = () => {
      for (const f of uploadedFiles)   fs.unlink(f.path,   () => {});
      for (const fp of processedFiles) fs.unlink(fp,       () => {});
      if (compositePath)               fs.unlink(compositePath, () => {});
    };

    const { caption, job_id } = req.body ?? {};

    if (!caption || typeof caption !== 'string' || !caption.trim()) {
      cleanup();
      return res.status(400).json({ error: 'caption is required' });
    }
    if (!job_id || typeof job_id !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'job_id is required' });
    }

    const featuredIndex   = parseInt(req.body.featured_index ?? '0', 10) || 0;
    const classifications = parseIntArray(req.body.classifications) ?? [];

    const pool      = getPool();
    const now       = Date.now();
    const serverUrl = process.env.SERVER_URL ?? 'https://api.getelmer.com';

    // Fetch Instagram account for this user
    let igAccount;
    try {
      const { rows } = await pool.query(
        `SELECT id, account_id, account_name, access_token_enc, token_expires_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'instagram'
         LIMIT 1`,
        [req.userId]
      );
      igAccount = rows[0];
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    if (!igAccount) {
      cleanup();
      return res.status(422).json({ error: 'no_instagram_account', detail: 'No Instagram account connected.' });
    }

    if (igAccount.token_expires_at && igAccount.token_expires_at < now) {
      cleanup();
      return res.status(422).json({ error: 'token_expired', detail: 'Instagram access token has expired. Reconnect in Settings.' });
    }

    let igToken;
    try {
      igToken = decrypt(igAccount.access_token_enc);
    } catch {
      cleanup();
      return res.status(500).json({ error: 'Could not read Instagram credentials.' });
    }

    const igUserId = igAccount.account_id;

    // Sort incoming photo files by field name (photo_0, photo_1, …)
    let photoFiles = uploadedFiles
      .filter(f => /^photo_\d+$/.test(f.fieldname))
      .sort((a, b) => {
        const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
        const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
        return ai - bi;
      });

    if (photoFiles.length === 0) {
      cleanup();
      return res.status(400).json({ error: 'At least one photo is required for Instagram.' });
    }

    // Move featured photo to front
    photoFiles = orderWithFeaturedFirst(photoFiles, featuredIndex);

    // Check for a complete before/after pair to generate a composite
    const classMap = {};
    photoFiles.forEach((f, i) => {
      const cls = (classifications[i] ?? 'General');
      classMap[cls] = classMap[cls] ?? [];
      classMap[cls].push(f);
    });

    const beforeFiles = classMap['Before'] ?? [];
    const afterFiles  = classMap['After']  ?? [];
    const hasCompletePair = beforeFiles.length > 0 && afterFiles.length > 0;

    if (hasCompletePair) {
      try {
        compositePath = await generateBeforeAfterComposite(
          beforeFiles[0].path,
          afterFiles[0].path,
          MEDIA_DIR
        );
        // Replace before/after files in the array with the composite first
        // then keep remaining non-before/non-after photos
        const otherFiles = photoFiles.filter((_, i) => {
          const cls = classifications[i] ?? 'General';
          return cls !== 'Before' && cls !== 'After';
        });
        photoFiles = [{ path: compositePath, mimetype: 'image/jpeg' }, ...otherFiles];
      } catch (err) {
        console.warn('[instagram] composite generation failed, using original photos:', err.message);
        compositePath = null;
      }
    }

    // Limit to MAX_CAROUSEL
    photoFiles = photoFiles.slice(0, MAX_CAROUSEL);

    // Idempotency check
    const jobRef = `ig_${req.userId}_${job_id}`;
    try {
      const { rows } = await pool.query(
        `SELECT id, platform_post_id
         FROM publishing_records
         WHERE user_id = $1 AND platform = 'instagram' AND job_ref = $2 AND status = 'published'
         LIMIT 1`,
        [req.userId, jobRef]
      );
      if (rows[0]) {
        cleanup();
        const postId  = rows[0].platform_post_id;
        return res.json({
          ok: true,
          duplicate: true,
          accountId:   igUserId,
          accountName: igAccount.account_name,
          postId,
          postUrl: `https://www.instagram.com/p/${postId}/`,
        });
      }
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    // Prepare images for Instagram (aspect ratio, JPEG, orientation).
    // Falls back to original files if processing fails (e.g., stub files in tests).
    let preparedPaths;
    if (photoFiles.length === 1) {
      try {
        const prepared = await prepareForInstagram(photoFiles[0].path);
        if (prepared !== photoFiles[0].path) processedFiles.push(prepared);
        preparedPaths = [prepared];
      } catch (err) {
        console.warn('[instagram] image preparation failed, using original:', err.message);
        preparedPaths = [photoFiles[0].path];
      }
    } else {
      try {
        const prepared = await prepareCarouselForInstagram(photoFiles.map(f => f.path));
        // Only track paths that differ from originals (i.e., newly created files)
        prepared.forEach((p, i) => { if (p !== photoFiles[i].path) processedFiles.push(p); });
        preparedPaths = prepared;
      } catch (err) {
        console.warn('[instagram] carousel preparation failed, using originals:', err.message);
        preparedPaths = photoFiles.map(f => f.path);
      }
    }

    // Stage photos in the public MEDIA_DIR so Instagram can fetch them
    const mediaItems = [];
    for (const preparedPath of preparedPaths) {
      const uuid     = randomBytes(16).toString('hex');
      const filename = `${uuid}.jpg`;
      const destPath = path.join(MEDIA_DIR, filename);
      try {
        fs.copyFileSync(preparedPath, destPath);
      } catch {
        cleanup();
        return res.status(500).json({ error: 'Failed to stage media file.' });
      }
      mediaItems.push({ publicUrl: `${serverUrl}/instagram/media/${filename}`, stagedPath: destPath });
    }

    // Insert pending publishing record
    const { rows: [record] } = await pool.query(
      `INSERT INTO publishing_records
         (user_id, platform, job_ref, status, created_at, updated_at)
       VALUES ($1, 'instagram', $2, 'pending', $3, $4) RETURNING id`,
      [req.userId, jobRef, now, now]
    );
    const recordId = record.id;

    const markFailed = async (msg) => {
      await pool.query(
        `UPDATE publishing_records SET status = 'failed', error_message = $1, updated_at = $2
         WHERE id = $3`,
        [msg, Date.now(), recordId]
      ).catch(() => {});
    };

    try {
      let postId;

      if (mediaItems.length === 1) {
        // Single image
        const cData = await igFetch(`${IG_GRAPH_BASE}/${IG_API_VERSION}/${igUserId}/media`, {
          method: 'POST',
          body: new URLSearchParams({
            media_type:   'IMAGE',
            image_url:    mediaItems[0].publicUrl,
            caption:      caption.trim(),
            access_token: igToken,
          }),
        }).then(r => r.json());

        if (cData.error) {
          throw Object.assign(new Error(cData.error.message), { isIgError: true, igCode: cData.error.code });
        }
        fs.unlink(mediaItems[0].stagedPath, () => {});

        await waitForContainer(cData.id, igToken, igFetch);

        const pData = await igFetch(`${IG_GRAPH_BASE}/${IG_API_VERSION}/${igUserId}/media_publish`, {
          method: 'POST',
          body: new URLSearchParams({ creation_id: cData.id, access_token: igToken }),
        }).then(r => r.json());

        if (pData.error) {
          throw Object.assign(new Error(pData.error.message), { isIgError: true, igCode: pData.error.code });
        }
        postId = pData.id;

      } else {
        // Carousel — create and wait for each child container, then the album container
        const childIds = [];
        for (const item of mediaItems) {
          const cData = await igFetch(`${IG_GRAPH_BASE}/${IG_API_VERSION}/${igUserId}/media`, {
            method: 'POST',
            body: new URLSearchParams({
              media_type:        'IMAGE',
              image_url:         item.publicUrl,
              is_carousel_item:  'true',
              access_token:      igToken,
            }),
          }).then(r => r.json());

          if (cData.error) {
            throw Object.assign(new Error(cData.error.message), { isIgError: true, igCode: cData.error.code });
          }
          fs.unlink(item.stagedPath, () => {});
          await waitForContainer(cData.id, igToken, igFetch);
          childIds.push(cData.id);
        }

        const carData = await igFetch(`${IG_GRAPH_BASE}/${IG_API_VERSION}/${igUserId}/media`, {
          method: 'POST',
          body: new URLSearchParams({
            media_type:   'CAROUSEL',
            children:     childIds.join(','),
            caption:      caption.trim(),
            access_token: igToken,
          }),
        }).then(r => r.json());

        if (carData.error) {
          throw Object.assign(new Error(carData.error.message), { isIgError: true, igCode: carData.error.code });
        }

        await waitForContainer(carData.id, igToken, igFetch);

        const pData = await igFetch(`${IG_GRAPH_BASE}/${IG_API_VERSION}/${igUserId}/media_publish`, {
          method: 'POST',
          body: new URLSearchParams({ creation_id: carData.id, access_token: igToken }),
        }).then(r => r.json());

        if (pData.error) {
          throw Object.assign(new Error(pData.error.message), { isIgError: true, igCode: pData.error.code });
        }
        postId = pData.id;
      }

      const postUrl = `https://www.instagram.com/p/${postId}/`;

      await pool.query(
        `UPDATE publishing_records
         SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
         WHERE id = $4`,
        [postId, now, now, recordId]
      );

      cleanup();
      return res.json({
        ok:          true,
        accountId:   igUserId,
        accountName: igAccount.account_name,
        postId,
        postUrl,
      });

    } catch (err) {
      console.error('[instagram] publish error:', err.message);
      await markFailed(err.message);
      cleanup();
      return res.json({
        ok:          false,
        accountId:   igUserId,
        accountName: igAccount.account_name,
        error:       err.message,
        igError:     err.isIgError ?? false,
        igCode:      err.igCode    ?? null,
      });
    }
  });

  return router;
}

module.exports = { createInstagramRouter };
