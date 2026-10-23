'use strict';

const { Router } = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const multer     = require('multer');

const { getPool }          = require('../db');
const { requireAuth }      = require('../auth');
const { tryReserveFreePublication, redeemFreePublication, releaseFreePublicationIfNoSuccess } = require('./billing');
const { encrypt, decrypt } = require('../crypto');
const { orderWithFeaturedFirst } = require('./media-utils');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ── SSRF guard ───────────────────────────────────────────────────────────────

const PRIVATE_HOSTNAME_RE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|::1$|fd[0-9a-f]{2}:)/i;
const PRIVATE_172_RE      = /^172\.(1[6-9]|2\d|3[01])\./;

function isPrivateHost(host) {
  return PRIVATE_HOSTNAME_RE.test(host) || PRIVATE_172_RE.test(host);
}

function normalizeWordPressUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { error: 'Site URL is required' };
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try { parsed = new URL(withProto); } catch { return { error: 'Invalid URL' }; }
  if (parsed.protocol !== 'https:') return { error: 'WordPress site must use HTTPS' };
  if (isPrivateHost(parsed.hostname)) return { error: 'WordPress URL is not publicly accessible' };
  // Strip path — we'll use the origin only
  return { url: `${parsed.protocol}//${parsed.host}` };
}

// ── WordPress API helpers ────────────────────────────────────────────────────

async function checkWordPressInstallation(siteUrl, wpFetch) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await wpFetch(`${siteUrl}/wp-json/`, { signal: controller.signal });
    if (!res.ok) {
      return { error: `WordPress REST API not accessible (HTTP ${res.status}). Check the URL is correct and the REST API is enabled.` };
    }
    const data = await res.json();
    if (!data?.authentication?.['application-passwords']) {
      return {
        error:
          'This WordPress site does not support Application Passwords. ' +
          'Ensure your site runs WordPress 5.6+ and Application Passwords are not disabled by a plugin or host.',
      };
    }
    return { ok: true, siteName: (typeof data.name === 'string' ? data.name : null) ?? siteUrl };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'WordPress site timed out. Check the URL is correct and the site is publicly accessible.' };
    }
    return { error: `Could not reach WordPress site: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function getAuthHeader(userLogin, password) {
  return `Basic ${Buffer.from(`${userLogin}:${password}`).toString('base64')}`;
}

async function verifyWordPressCredentials(siteUrl, userLogin, password, wpFetch) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await wpFetch(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: getAuthHeader(userLogin, password) },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { error: `WordPress credential verification failed (HTTP ${res.status})` };
    }
    const user = await res.json();
    const caps = user.capabilities ?? {};
    if (!caps.publish_posts && !caps.edit_posts) {
      return { error: 'The WordPress user does not have permission to publish posts. An Editor or Administrator role is required.' };
    }
    return { ok: true, userId: user.id, displayName: user.name ?? userLogin };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'WordPress credential verification timed out.' };
    return { error: `Could not verify WordPress credentials: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Markdown → HTML ───────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function markdownToHtml(md) {
  if (!md || typeof md !== 'string') return '';
  const blocks = md.trim().split(/\n{2,}/);
  return blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('### ')) return `<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`;
    if (trimmed.startsWith('## '))  return `<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`;
    if (trimmed.startsWith('# '))   return `<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`;
    // Multi-line paragraph — join lines
    const joined = trimmed.split('\n').map(l => l.trim()).join(' ');
    return `<p>${inlineMarkdown(joined)}</p>`;
  }).filter(Boolean).join('\n');
}

// Distribute non-featured photos as figure blocks within the article.
// Inserts one image after every 2nd h2/h3 heading (best-effort; appends remainder at end).
function embedImagesInContent(htmlContent, mediaItems) {
  if (!mediaItems.length) return htmlContent;
  let photoIdx = 0;

  // Split content at h2/h3 boundaries
  const sections = htmlContent.split(/(?=<h[23])/);
  const result   = [];

  for (let i = 0; i < sections.length; i++) {
    result.push(sections[i]);
    // Insert a photo after every other section (skip the first)
    if (i > 0 && i % 2 === 0 && photoIdx < mediaItems.length) {
      const m = mediaItems[photoIdx++];
      result.push(
        `\n<figure class="wp-block-image size-large"><img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt)}" /></figure>\n`
      );
    }
  }

  // Append remaining photos
  while (photoIdx < mediaItems.length) {
    const m = mediaItems[photoIdx++];
    result.push(
      `\n<figure class="wp-block-image size-large"><img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt)}" /></figure>\n`
    );
  }

  return result.join('');
}

async function uploadMediaToWordPress(siteUrl, userLogin, password, filePath, altText, wpFetch) {
  const fileData = fs.readFileSync(filePath);
  const filename = `elmer-photo-${Date.now()}.jpg`;
  const res = await wpFetch(`${siteUrl}/wp-json/wp/v2/media`, {
    method:  'POST',
    headers: {
      Authorization:        getAuthHeader(userLogin, password),
      'Content-Type':       'image/jpeg',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: fileData,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Media upload failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const media = await res.json();
  return { id: media.id, url: media.source_url, alt: altText };
}

// ── Router factory ────────────────────────────────────────────────────────────

function createWordPressRouter({ wpFetch = (...args) => fetch(...args) } = {}) {
  const TMP_DIR = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const upload = multer({ dest: TMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });
  const router = Router();

  // ── POST /wordpress/connect-url ─────────────────────────────────────────────
  // Validates the site URL, checks WP installation, creates an oauth_states record,
  // and returns the WordPress Application Password authorization URL.
  router.post('/connect-url', requireAuth, async (req, res, next) => {
    try {
      const { siteUrl } = req.body ?? {};
      const norm = normalizeWordPressUrl(siteUrl);
      if (norm.error) return res.status(400).json({ error: norm.error });

      const check = await checkWordPressInstallation(norm.url, wpFetch);
      if (!check.ok) return res.status(422).json({ error: check.error });

      const state = crypto.randomBytes(24).toString('hex');
      const now   = Date.now();
      await getPool().query(
        `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
         VALUES ($1, $2, 'wordpress', $3, $4)`,
        [state, req.userId, now, now + OAUTH_STATE_TTL_MS]
      );

      const callbackBase = process.env.WORDPRESS_CALLBACK_URL
        ?? `${process.env.SERVER_URL ?? 'https://api.getelmer.com'}/wordpress/callback`;

      const successUrl = `${callbackBase}?state=${encodeURIComponent(state)}&expected_site=${encodeURIComponent(norm.url)}`;
      const rejectUrl  = `${callbackBase}?state=${encodeURIComponent(state)}&error=rejected`;

      const authUrl = `${norm.url}/wp-admin/authorize-application.php?${new URLSearchParams({
        app_name:    'Elmer',
        success_url: successUrl,
        reject_url:  rejectUrl,
      })}`;

      return res.json({ authUrl });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /wordpress/callback ──────────────────────────────────────────────────
  // Public — WordPress redirects here after Application Password authorization.
  // Validates state, verifies credentials, encrypts and stores them.
  router.get('/callback', async (req, res) => {
    const returnScheme = process.env.FACEBOOK_OAUTH_RETURN_SCHEME ?? 'elmer';
    const returnBase   = `${returnScheme}://oauth/callback`;

    const { state, site_url, user_login, password, error: wpError } = req.query;

    if (wpError) {
      return res.redirect(`${returnBase}?platform=wordpress&error=${encodeURIComponent(String(wpError))}`);
    }

    if (!state || !site_url || !user_login || !password ||
        typeof state !== 'string' || typeof site_url !== 'string' ||
        typeof user_login !== 'string' || typeof password !== 'string') {
      return res.redirect(`${returnBase}?platform=wordpress&error=missing_params`);
    }

    // SSRF guard on site_url returned by WordPress
    const norm = normalizeWordPressUrl(site_url);
    if (norm.error) {
      console.warn('[wp] callback: SSRF guard rejected site_url:', site_url);
      return res.redirect(`${returnBase}?platform=wordpress&error=invalid_site`);
    }
    const normalizedSite = norm.url;

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
           FROM oauth_states WHERE state = $1 AND platform = 'wordpress' FOR UPDATE`,
          [state]
        );
        stateRow = rows[0];
        if (!stateRow) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=wordpress&error=invalid_state`);
        }
        if (stateRow.used_at) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=wordpress&error=state_already_used`);
        }
        if (stateRow.expires_at < now) {
          await client.query('ROLLBACK');
          return res.redirect(`${returnBase}?platform=wordpress&error=state_expired`);
        }
        await client.query('UPDATE oauth_states SET used_at = $1 WHERE id = $2', [now, stateRow.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Verify credentials against the WordPress site
      const verification = await verifyWordPressCredentials(normalizedSite, user_login, password, wpFetch);
      if (!verification.ok) {
        console.warn('[wp] callback: credential verification failed:', verification.error);
        return res.redirect(`${returnBase}?platform=wordpress&error=auth_failed`);
      }

      // Encrypt and store the credentials
      // account_id = normalizedSite (allows multiple sites per user)
      // access_token_enc = encrypted JSON { userLogin, password }
      const credentialJson = JSON.stringify({ userLogin: user_login, password });
      const tokenEnc       = encrypt(credentialJson);

      // Fetch site name from WP API for a friendly label
      let siteName = normalizedSite;
      try {
        const infoRes = await wpFetch(`${normalizedSite}/wp-json/`);
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (typeof info.name === 'string' && info.name) siteName = info.name;
        }
      } catch { /* best effort */ }

      await pool.query(
        `INSERT INTO connected_platforms
           (user_id, platform, account_name, account_id, access_token_enc,
            selected, connected_at, updated_at)
         VALUES ($1, 'wordpress', $2, $3, $4, true, $5, $6)
         ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
           account_name     = EXCLUDED.account_name,
           access_token_enc = EXCLUDED.access_token_enc,
           updated_at       = EXCLUDED.updated_at`,
        [stateRow.user_id, siteName, normalizedSite, tokenEnc, now, now]
      );

      console.log('[wp] callback: connected site', normalizedSite, 'for user', stateRow.user_id);
      return res.redirect(`${returnBase}?platform=wordpress&success=true&site_name=${encodeURIComponent(siteName)}`);

    } catch (err) {
      console.error('[wp] callback error:', err.message);
      return res.redirect(`${returnBase}?platform=wordpress&error=auth_failed`);
    }
  });

  // ── GET /wordpress/sites ──────────────────────────────────────────────────────
  // Returns the list of connected WordPress sites for the authenticated user.
  router.get('/sites', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await getPool().query(
        `SELECT id, account_name, account_id, connected_at, updated_at
         FROM connected_platforms
         WHERE user_id = $1 AND platform = 'wordpress'
         ORDER BY connected_at DESC`,
        [req.userId]
      );
      return res.json({ sites: rows });
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /wordpress/sites/:id ───────────────────────────────────────────────
  // Revokes the Application Password on the WordPress site (best effort)
  // then removes the connection from our database.
  router.delete('/sites/:id', requireAuth, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.id, 10);
      if (!Number.isInteger(siteId) || siteId < 1) {
        return res.status(400).json({ error: 'Invalid site ID' });
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, account_id, access_token_enc
         FROM connected_platforms
         WHERE id = $1 AND user_id = $2 AND platform = 'wordpress'`,
        [siteId, req.userId]
      );
      const site = rows[0];
      if (!site) return res.status(404).json({ error: 'WordPress site not found' });

      // Best-effort revocation
      try {
        const creds = JSON.parse(decrypt(site.access_token_enc));
        const appPassRes = await wpFetch(
          `${site.account_id}/wp-json/wp/v2/users/me/application-passwords`,
          { headers: { Authorization: getAuthHeader(creds.userLogin, creds.password) } }
        );
        if (appPassRes.ok) {
          const passwords = await appPassRes.json();
          const elmers    = Array.isArray(passwords)
            ? passwords.filter(p => p.name === 'Elmer')
            : [];
          for (const ap of elmers) {
            await wpFetch(
              `${site.account_id}/wp-json/wp/v2/users/me/application-passwords/${ap.uuid}`,
              {
                method:  'DELETE',
                headers: { Authorization: getAuthHeader(creds.userLogin, creds.password) },
              }
            ).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[wp] revocation best-effort failed:', err.message);
      }

      await pool.query('DELETE FROM connected_platforms WHERE id = $1', [siteId]);
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /wordpress/publish ───────────────────────────────────────────────────
  // Multipart fields:
  //   title        — article title (required)
  //   content      — markdown content (required)
  //   job_id       — string, for idempotency (required)
  //   wp_site_id   — connected_platforms.id to publish to (required)
  //   seo_slug     — URL slug (optional)
  //   seo_excerpt  — meta description used as post excerpt (optional)
  //   photo_0..N   — image files (optional)
  //   featured_index — integer, index of featured photo (optional, default 0)
  //   classifications — JSON array of photo classification strings (optional)
  router.post('/publish', requireAuth, upload.any(), async (req, res) => {
    const uploadedFiles = req.files ?? [];
    const cleanup = () => uploadedFiles.forEach(f => fs.unlink(f.path, () => {}));

    const { title, content, job_id, wp_site_id } = req.body ?? {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      cleanup();
      return res.status(400).json({ error: 'title is required' });
    }
    if (!content || typeof content !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'content is required' });
    }
    if (!job_id || typeof job_id !== 'string') {
      cleanup();
      return res.status(400).json({ error: 'job_id is required' });
    }

    // Track free publication usage — non-blocking; enforcement added in a later phase
    const freePubReserved = await tryReserveFreePublication(req.userId, job_id).catch(() => false);

    if (!wp_site_id) {
      cleanup();
      return res.status(400).json({ error: 'wp_site_id is required' });
    }

    const siteId = parseInt(String(wp_site_id), 10);
    if (!Number.isInteger(siteId) || siteId < 1) {
      cleanup();
      return res.status(400).json({ error: 'Invalid wp_site_id' });
    }

    const featuredIndex = parseInt(req.body.featured_index ?? '0', 10) || 0;
    let classifications = [];
    try {
      const raw = req.body.classifications;
      if (raw) classifications = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { /* ignore */ }

    const seoSlug    = (req.body.seo_slug    ?? '').trim();
    const seoExcerpt = (req.body.seo_excerpt ?? '').trim();

    const pool = getPool();
    const now  = Date.now();

    // Load site connection
    let site;
    try {
      const { rows } = await pool.query(
        `SELECT id, account_id, account_name, access_token_enc
         FROM connected_platforms
         WHERE id = $1 AND user_id = $2 AND platform = 'wordpress'`,
        [siteId, req.userId]
      );
      site = rows[0];
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    if (!site) {
      cleanup();
      return res.status(422).json({ error: 'no_wordpress_site', detail: 'WordPress site not connected.' });
    }

    let creds;
    try {
      creds = JSON.parse(decrypt(site.access_token_enc));
    } catch {
      cleanup();
      return res.status(500).json({ error: 'Could not read WordPress credentials.' });
    }

    const siteUrl   = site.account_id;
    const authHeader = getAuthHeader(creds.userLogin, creds.password);

    // Idempotency check
    const jobRef = `wp_${req.userId}_${job_id}_${siteId}`;
    try {
      const { rows } = await pool.query(
        `SELECT id, platform_post_id
         FROM publishing_records
         WHERE user_id = $1 AND platform = 'wordpress' AND job_ref = $2 AND status = 'published'
         LIMIT 1`,
        [req.userId, jobRef]
      );
      if (rows[0]) {
        cleanup();
        const postId  = rows[0].platform_post_id;
        // Reconstruct post URL
        const postUrl = postId ? `${siteUrl}?p=${postId}` : siteUrl;
        return res.json({ ok: true, duplicate: true, siteId, siteName: site.account_name, postId, postUrl });
      }
    } catch (err) {
      cleanup();
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }

    // Insert pending record
    const { rows: [record] } = await pool.query(
      `INSERT INTO publishing_records
         (user_id, platform, job_ref, client_job_id, status, created_at, updated_at)
       VALUES ($1, 'wordpress', $2, $3, 'pending', $4, $5) RETURNING id`,
      [req.userId, jobRef, job_id, now, now]
    );
    const recordId = record.id;

    const markFailed = async (msg) => {
      await pool.query(
        `UPDATE publishing_records SET status = 'failed', error_message = $1, updated_at = $2 WHERE id = $3`,
        [msg, Date.now(), recordId]
      ).catch(() => {});
    };

    // Sort photo files
    let photoFiles = uploadedFiles
      .filter(f => /^photo_\d+$/.test(f.fieldname))
      .sort((a, b) => {
        const ai = parseInt(a.fieldname.replace('photo_', ''), 10);
        const bi = parseInt(b.fieldname.replace('photo_', ''), 10);
        return ai - bi;
      });
    photoFiles = orderWithFeaturedFirst(photoFiles, featuredIndex);

    try {
      // Upload photos to WordPress media library
      const uploadedMedia = [];
      const altTexts = [];
      for (let i = 0; i < photoFiles.length; i++) {
        const cls = classifications[i] ?? 'General';
        altTexts.push(cls !== 'General' ? `${cls} photo` : `Photo ${i + 1}`);
      }

      for (let i = 0; i < photoFiles.length; i++) {
        try {
          const media = await uploadMediaToWordPress(
            siteUrl,
            creds.userLogin,
            creds.password,
            photoFiles[i].path,
            altTexts[i],
            wpFetch
          );
          uploadedMedia.push(media);
          console.log(`[wp] uploaded media ${i + 1}/${photoFiles.length}: id=${media.id}`);
        } catch (err) {
          console.warn(`[wp] media upload ${i + 1} failed (skipping):`, err.message);
        }
      }

      // Build post content HTML with embedded images (non-featured photos)
      let htmlContent = markdownToHtml(content);
      if (uploadedMedia.length > 1) {
        htmlContent = embedImagesInContent(htmlContent, uploadedMedia.slice(1));
      }

      const featuredMediaId = uploadedMedia.length > 0 ? uploadedMedia[0].id : undefined;

      // Build post body
      const postBody = {
        title:   title.trim(),
        content: htmlContent,
        status:  'publish',
      };
      if (seoSlug)        postBody.slug    = seoSlug;
      if (seoExcerpt)     postBody.excerpt = seoExcerpt;
      if (featuredMediaId) postBody.featured_media = featuredMediaId;

      // Create and publish the post
      const postRes = await wpFetch(`${siteUrl}/wp-json/wp/v2/posts`, {
        method:  'POST',
        headers: {
          Authorization:  authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(postBody),
      });

      if (!postRes.ok) {
        const body = await postRes.text().catch(() => '');
        throw new Error(`WordPress post creation failed (HTTP ${postRes.status}): ${body.slice(0, 300)}`);
      }

      const post    = await postRes.json();
      const postId  = String(post.id);
      const postUrl = post.link ?? `${siteUrl}?p=${postId}`;

      await pool.query(
        `UPDATE publishing_records
         SET status = 'published', platform_post_id = $1, published_at = $2, updated_at = $3
         WHERE id = $4`,
        [postId, now, now, recordId]
      );

      cleanup();
      if (freePubReserved) await redeemFreePublication(req.userId, job_id).catch(() => {});
      console.log('[wp] published post id=', postId, 'url=', postUrl, 'site=', siteUrl);
      return res.json({ ok: true, siteId, siteName: site.account_name, postId, postUrl });

    } catch (err) {
      console.error('[wp] publish error:', err.message);
      await markFailed(err.message);
      cleanup();
      if (freePubReserved) await releaseFreePublicationIfNoSuccess(req.userId, job_id).catch(() => {});
      return res.json({ ok: false, siteId, siteName: site.account_name, error: err.message });
    }
  });

  return router;
}

module.exports = { createWordPressRouter, markdownToHtml, normalizeWordPressUrl };
