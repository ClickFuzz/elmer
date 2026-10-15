'use strict';

const { Router }      = require('express');
const { randomBytes } = require('crypto');
const fs              = require('fs');
const path            = require('path');
const multer          = require('multer');
const { getPool }     = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { requireAuth } = require('../auth');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GRAPH_API_VERSION  = 'v21.0';
const GRAPH_BASE         = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const FB_DIALOG_URL      = 'https://www.facebook.com/dialog/oauth';
const FB_PERMISSIONS     = 'pages_show_list,pages_read_engagement,pages_manage_posts';

function createFacebookRouter({ graphFetch = (...args) => fetch(...args) } = {}) {
  const TMP_DIR = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
  const upload = multer({ dest: TMP_DIR });

  const router = Router();

  // ── POST /facebook/connect-url ──────────────────────────────────────────────
  router.post('/connect-url', requireAuth, async (req, res, next) => {
    try {
      const appId       = process.env.FACEBOOK_APP_ID       ?? '';
      const redirectUri = process.env.FACEBOOK_REDIRECT_URI ?? '';

      if (!appId || !redirectUri) {
        return res.status(503).json({ error: 'Facebook integration not configured on this server' });
      }

      const state = randomBytes(24).toString('hex');
      const now   = Date.now();

      await getPool().query(
        `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
         VALUES ($1, $2, 'facebook', $3, $4)`,
        [state, req.userId, now, now + OAUTH_STATE_TTL_MS]
      );

      const params = new URLSearchParams({
        client_id:     appId,
        redirect_uri:  redirectUri,
        state,
        scope:         FB_PERMISSIONS,
        response_type: 'code',
      });

      return res.json({ authUrl: `${FB_DIALOG_URL}?${params}` });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /facebook/callback ──────────────────────────────────────────────────
  router.get('/callback', async (req, res) => {
    const appId        = process.env.FACEBOOK_APP_ID        ?? '';
    const appSecret    = process.env.FACEBOOK_APP_SECRET    ?? '';
    const redirectUri  = process.env.FACEBOOK_REDIRECT_URI  ?? '';
    const returnScheme = process.env.FACEBOOK_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase   = `${returnScheme}://oauth/callback`;

    const { code, state, error: fbError, error_description } = req.query;
    console.log('[facebook] callback hit — code:', !!code, '| state:', !!state, '| fbError:', fbError ?? 'none');

    if (fbError) {
      const reason = (typeof error_description === 'string' ? error_description : fbError);
      return res.redirect(`${returnBase}?platform=facebook&error=${encodeURIComponent(reason)}`);
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      return res.redirect(`${returnBase}?platform=facebook&error=missing_params`);
    }

    if (!appId || !appSecret || !redirectUri) {
      return res.redirect(`${returnBase}?platform=facebook&error=server_not_configured`);
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
           FROM oauth_states WHERE state = $1 AND platform = 'facebook'
           FOR UPDATE`,
          [state]
        );
        stateRow = rows[0];

        if (!stateRow) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=facebook&error=invalid_state`);
        }
        if (stateRow.used_at) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=facebook&error=state_already_used`);
        }
        if (stateRow.expires_at < now) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=facebook&error=state_expired`);
        }

        await client.query('UPDATE oauth_states SET used_at = $1 WHERE id = $2', [now, stateRow.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Step 1 — Exchange code for short-lived user access token
      const tokenParams = new URLSearchParams({
        client_id:     appId,
        client_secret: appSecret,
        redirect_uri:  redirectUri,
        code,
      });
      const tokenData = await graphFetch(`${GRAPH_BASE}/oauth/access_token?${tokenParams}`)
        .then(r => r.json());

      if (tokenData.error) {
        throw new Error(`Token exchange: ${tokenData.error.message}`);
      }

      // Step 2 — Exchange for long-lived user token (~60 days)
      const longParams = new URLSearchParams({
        grant_type:        'fb_exchange_token',
        client_id:         appId,
        client_secret:     appSecret,
        fb_exchange_token: tokenData.access_token,
      });
      const longData = await graphFetch(`${GRAPH_BASE}/oauth/access_token?${longParams}`)
        .then(r => r.json());

      if (longData.error) {
        throw new Error(`Long-lived token: ${longData.error.message}`);
      }

      // Step 3 — Retrieve pages the user manages
      const pagesParams = new URLSearchParams({
        access_token: longData.access_token,
        fields:       'id,name,access_token,tasks',
        limit:        '25',
      });
      const pagesData = await graphFetch(`${GRAPH_BASE}/me/accounts?${pagesParams}`)
        .then(r => r.json());

      if (pagesData.error) {
        throw new Error(`Pages fetch: ${pagesData.error.message}`);
      }

      const pages = (pagesData.data ?? []).filter(p => p.id && p.access_token);

      if (pages.length === 0) {
        return res.redirect(`${returnBase}?platform=facebook&error=no_manageable_pages`);
      }

      // Step 4 — Persist each page's access token encrypted
      for (const page of pages) {
        const tokenEnc = encrypt(page.access_token);
        await pool.query(
          `INSERT INTO connected_platforms
             (user_id, platform, account_name, account_id, access_token_enc, connected_at, updated_at)
           VALUES ($1, 'facebook', $2, $3, $4, $5, $6)
           ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
             account_name     = EXCLUDED.account_name,
             access_token_enc = EXCLUDED.access_token_enc,
             updated_at       = EXCLUDED.updated_at`,
          [stateRow.user_id, page.name, page.id, tokenEnc, now, now]
        );
      }

      return res.redirect(
        `${returnBase}?platform=facebook&success=true&page_count=${pages.length}`
      );

    } catch (err) {
      console.error('[facebook] callback error:', err.message);
      return res.redirect(`${returnBase}?platform=facebook&error=auth_failed`);
    }
  });

  // ── GET /facebook/pages ─────────────────────────────────────────────────────
  router.get('/pages', requireAuth, async (req, res, next) => {
    try {
      const { rows: pages } = await getPool().query(
        `SELECT id, account_name, account_id, connected_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'facebook'
         ORDER BY account_name ASC`,
        [req.userId]
      );
      return res.json({ pages });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /facebook/publish ──────────────────────────────────────────────────
  router.post('/publish', requireAuth, upload.any(), async (req, res) => {
    const uploadedFiles = req.files ?? [];
    const cleanup = () => {
      for (const f of uploadedFiles) fs.unlink(f.path, () => {});
    };

    const { message, platform_id, job_id } = req.body ?? {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      cleanup();
      return res.status(400).json({ error: 'message is required' });
    }

    const platformId = parseInt(platform_id, 10);
    if (!Number.isInteger(platformId) || platformId < 1) {
      cleanup();
      return res.status(400).json({ error: 'platform_id must be a positive integer' });
    }

    if (!job_id || typeof job_id !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'job_id is required' });
    }

    const pool     = getPool();
    const now      = Date.now();
    const jobRef   = `fb_${req.userId}_${job_id}`;
    let   recordId = null;

    const markFailed = async (msg) => {
      if (!recordId) return;
      await pool.query(
        `UPDATE publishing_records SET status = 'failed', error_message = $1, updated_at = $2
         WHERE id = $3`,
        [msg, Date.now(), recordId]
      ).catch(() => {});
    };

    try {
      // Verify the requested page belongs to this user
      const { rows: pageRows } = await pool.query(
        `SELECT account_id, access_token_enc
         FROM connected_platforms
         WHERE id = $1 AND user_id = $2 AND platform = 'facebook'`,
        [platformId, req.userId]
      );
      const pageRow = pageRows[0];

      if (!pageRow) {
        cleanup();
        return res.status(404).json({ error: 'Facebook page not found' });
      }

      // Idempotency — return immediately if this job was already published
      const { rows: publishedRows } = await pool.query(
        `SELECT id, platform_post_id
         FROM publishing_records
         WHERE user_id = $1 AND platform = 'facebook' AND job_ref = $2 AND status = 'published'
         LIMIT 1`,
        [req.userId, jobRef]
      );
      const published = publishedRows[0];

      if (published) {
        cleanup();
        return res.json({ ok: true, duplicate: true, postId: published.platform_post_id });
      }

      // Decrypt the page access token
      let pageToken;
      try {
        pageToken = decrypt(pageRow.access_token_enc);
      } catch (err) {
        cleanup();
        console.error('[facebook] token decrypt error:', err.message);
        return res.status(500).json({ error: 'Could not read page credentials' });
      }

      const pageId = pageRow.account_id;

      // Record pending publish attempt
      const { rows: [record] } = await pool.query(
        `INSERT INTO publishing_records
           (user_id, platform, job_ref, status, created_at, updated_at)
         VALUES ($1, 'facebook', $2, 'pending', $3, $4) RETURNING id`,
        [req.userId, jobRef, now, now]
      );
      recordId = record.id;

      // Sort photo files by field name (photo_0, photo_1, …)
      const photoFiles = uploadedFiles
        .filter(f => /^photo_\d+$/.test(f.fieldname))
        .sort((a, b) => {
          const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
          const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
          return ai - bi;
        })
        .slice(0, 5);

      let postId;

      if (photoFiles.length === 0) {
        const body = new URLSearchParams({ message, access_token: pageToken });
        const data = await graphFetch(`${GRAPH_BASE}/${pageId}/feed`, {
          method: 'POST', body,
        }).then(r => r.json());

        if (data.error) {
          const e = Object.assign(new Error(data.error.message), { isFbError: true, fbCode: data.error.code });
          throw e;
        }
        postId = data.id;

      } else if (photoFiles.length === 1) {
        const form = new FormData();
        form.append(
          'source',
          new Blob([fs.readFileSync(photoFiles[0].path)], { type: photoFiles[0].mimetype || 'image/jpeg' }),
          photoFiles[0].originalname || 'photo.jpg'
        );
        form.append('message', message);
        form.append('access_token', pageToken);

        const data = await graphFetch(`${GRAPH_BASE}/${pageId}/photos`, {
          method: 'POST', body: form,
        }).then(r => r.json());

        if (data.error) {
          const e = Object.assign(new Error(data.error.message), { isFbError: true, fbCode: data.error.code });
          throw e;
        }
        postId = data.post_id ?? data.id;

      } else {
        const mediaFbids = [];

        for (const photoFile of photoFiles) {
          const form = new FormData();
          form.append(
            'source',
            new Blob([fs.readFileSync(photoFile.path)], { type: photoFile.mimetype || 'image/jpeg' }),
            photoFile.originalname || 'photo.jpg'
          );
          form.append('published', 'false');
          form.append('access_token', pageToken);

          const data = await graphFetch(`${GRAPH_BASE}/${pageId}/photos`, {
            method: 'POST', body: form,
          }).then(r => r.json());

          if (data.error) {
            const e = Object.assign(new Error(data.error.message), { isFbError: true, fbCode: data.error.code });
            throw e;
          }
          mediaFbids.push(data.id);
        }

        const body = new URLSearchParams({
          message,
          access_token:   pageToken,
          attached_media: JSON.stringify(mediaFbids.map(id => ({ media_fbid: id }))),
        });
        const feedData = await graphFetch(`${GRAPH_BASE}/${pageId}/feed`, {
          method: 'POST', body,
        }).then(r => r.json());

        if (feedData.error) {
          const e = Object.assign(new Error(feedData.error.message), { isFbError: true, fbCode: feedData.error.code });
          throw e;
        }
        postId = feedData.id;
      }

      const postUrl = `https://www.facebook.com/${String(postId).replace('_', '/posts/')}`;

      await pool.query(
        `UPDATE publishing_records
         SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
         WHERE id = $4`,
        [postId, now, now, recordId]
      );

      cleanup();
      return res.json({ ok: true, postId, postUrl });

    } catch (err) {
      console.error('[facebook] publish error:', err.message);
      await markFailed(err.message);
      cleanup();

      if (err.isFbError) {
        return res.status(422).json({ error: err.message, fbError: true, fbCode: err.fbCode ?? null });
      }
      return res.status(502).json({ error: 'Failed to publish to Facebook', detail: err.message });
    }
  });

  return router;
}

module.exports = { createFacebookRouter };
