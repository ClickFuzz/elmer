'use strict';

const { Router }        = require('express');
const { randomBytes }   = require('crypto');
const fs                = require('fs');
const path              = require('path');
const multer            = require('multer');
const { getDb }         = require('../db');
const { requireAuth }   = require('../auth');
const { encrypt, decrypt } = require('../crypto');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE        = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const FB_DIALOG_URL     = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;
const FB_PERMISSIONS    = 'pages_show_list,pages_read_engagement,pages_manage_posts';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Factory ───────────────────────────────────────────────────────────────────
// Accepts a graphFetch override so tests can mock the Meta Graph API.

function createFacebookRouter({ graphFetch = (...args) => fetch(...args) } = {}) {
  const TMP_DIR = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
  const upload = multer({ dest: TMP_DIR });

  const router = Router();

  // ── POST /facebook/connect-url ──────────────────────────────────────────────
  // Creates an OAuth state and returns the Facebook authorization URL.
  // Mobile opens this URL in a browser to start the OAuth flow.
  router.post('/connect-url', requireAuth, (req, res) => {
    const appId       = process.env.FACEBOOK_APP_ID       ?? '';
    const redirectUri = process.env.FACEBOOK_REDIRECT_URI ?? '';

    if (!appId || !redirectUri) {
      return res.status(503).json({ error: 'Facebook integration not configured on this server' });
    }

    const state = randomBytes(24).toString('hex');
    const now   = Date.now();

    getDb().prepare(
      `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
       VALUES (?, ?, 'facebook', ?, ?)`
    ).run(state, req.userId, now, now + OAUTH_STATE_TTL_MS);

    const params = new URLSearchParams({
      client_id:     appId,
      redirect_uri:  redirectUri,
      state,
      scope:         FB_PERMISSIONS,
      response_type: 'code',
    });

    return res.json({ authUrl: `${FB_DIALOG_URL}?${params}` });
  });

  // ── GET /facebook/callback ──────────────────────────────────────────────────
  // Public endpoint — Facebook redirects here after the user authorises.
  // Validates the state, exchanges the code, stores page tokens, then
  // redirects to the app via a custom URI scheme deep link.
  router.get('/callback', async (req, res) => {
    const appId       = process.env.FACEBOOK_APP_ID        ?? '';
    const appSecret   = process.env.FACEBOOK_APP_SECRET    ?? '';
    const redirectUri = process.env.FACEBOOK_REDIRECT_URI  ?? '';
    const returnScheme = process.env.FACEBOOK_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase  = `${returnScheme}://oauth/callback`;

    const { code, state, error: fbError, error_description } = req.query;

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

    // Validate and atomically consume the state token
    const db  = getDb();
    const now = Date.now();

    const stateRow = db.prepare(
      `SELECT id, user_id, expires_at, used_at
       FROM oauth_states WHERE state = ? AND platform = 'facebook'`
    ).get(state);

    if (!stateRow) {
      return res.redirect(`${returnBase}?platform=facebook&error=invalid_state`);
    }
    if (stateRow.used_at) {
      return res.redirect(`${returnBase}?platform=facebook&error=state_already_used`);
    }
    if (stateRow.expires_at < now) {
      return res.redirect(`${returnBase}?platform=facebook&error=state_expired`);
    }

    db.prepare('UPDATE oauth_states SET used_at = ? WHERE id = ?').run(now, stateRow.id);

    try {
      // Step 1 — Exchange code for short-lived user access token
      const tokenParams = new URLSearchParams({
        client_id:    appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
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
        db.prepare(
          `INSERT INTO connected_platforms
             (user_id, platform, account_name, account_id, access_token_enc, connected_at, updated_at)
           VALUES (?, 'facebook', ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
             account_name     = excluded.account_name,
             access_token_enc = excluded.access_token_enc,
             updated_at       = excluded.updated_at`
        ).run(stateRow.user_id, page.name, page.id, tokenEnc, now, now);
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
  // Returns the authenticated user's connected Facebook pages (no tokens).
  router.get('/pages', requireAuth, (req, res) => {
    const pages = getDb().prepare(
      `SELECT id, account_name, account_id, connected_at
       FROM connected_platforms
       WHERE user_id = ? AND platform = 'facebook'
       ORDER BY account_name ASC`
    ).all(req.userId);
    return res.json({ pages });
  });

  // ── POST /facebook/publish ──────────────────────────────────────────────────
  // Publishes a social post (+ up to 5 photos) to a connected Facebook page.
  //
  // Multipart form fields:
  //   message     — required; the post text
  //   platform_id — required; connected_platforms.id (server row id for the page)
  //   job_id      — required; local device job reference (idempotency key)
  //   photo_0..4  — optional photo files (up to 5)
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

    const db  = getDb();
    const now = Date.now();

    // Verify the requested page belongs to this user
    const pageRow = db.prepare(
      `SELECT account_id, access_token_enc
       FROM connected_platforms
       WHERE id = ? AND user_id = ? AND platform = 'facebook'`
    ).get(platformId, req.userId);

    if (!pageRow) {
      cleanup();
      return res.status(404).json({ error: 'Facebook page not found' });
    }

    // Idempotency — return immediately if this job was already published
    const jobRef  = `fb_${req.userId}_${job_id}`;
    const published = db.prepare(
      `SELECT id, platform_post_id
       FROM publishing_records
       WHERE user_id = ? AND platform = 'facebook' AND job_ref = ? AND status = 'published'
       LIMIT 1`
    ).get(req.userId, jobRef);

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

    // Record pending publish attempt for traceability
    const { lastInsertRowid: recordId } = db.prepare(
      `INSERT INTO publishing_records
         (user_id, platform, job_ref, status, created_at, updated_at)
       VALUES (?, 'facebook', ?, 'pending', ?, ?)`
    ).run(req.userId, jobRef, now, now);

    // Sort photo files by field name (photo_0, photo_1, …)
    const photoFiles = uploadedFiles
      .filter(f => /^photo_\d+$/.test(f.fieldname))
      .sort((a, b) => {
        const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
        const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
        return ai - bi;
      })
      .slice(0, 5); // enforce max 5

    const markFailed = (msg) => {
      db.prepare(
        `UPDATE publishing_records SET status = 'failed', error_message = ?, updated_at = ?
         WHERE id = ?`
      ).run(msg, Date.now(), recordId);
    };

    try {
      let postId;

      if (photoFiles.length === 0) {
        // ── Text-only post ──────────────────────────────────────────────────
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
        // ── Single photo post ────────────────────────────────────────────────
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
        // post_id is the associated feed post; id is the photo's own id
        postId = data.post_id ?? data.id;

      } else {
        // ── Multi-photo post: stage each photo, then create a feed post ─────
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

        // Create the feed post referencing all staged photos
        const body = new URLSearchParams({
          message,
          access_token:    pageToken,
          attached_media:  JSON.stringify(mediaFbids.map(id => ({ media_fbid: id }))),
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

      // Build a best-effort permalink (format: {page_id}_{post_id_fragment})
      const postUrl = `https://www.facebook.com/${String(postId).replace('_', '/posts/')}`;

      db.prepare(
        `UPDATE publishing_records
         SET status = 'published', platform_post_id = ?, published_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(postId, now, now, recordId);

      cleanup();
      return res.json({ ok: true, postId, postUrl });

    } catch (err) {
      console.error('[facebook] publish error:', err.message);
      markFailed(err.message);
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
