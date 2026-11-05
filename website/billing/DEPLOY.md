# billing.getelmer.com — Deployment Plan

**Status: DO NOT DEPLOY until explicitly approved.**

---

## Pre-deployment status (verified 2026-11-05)

The following DirectAdmin configuration is **already in place** — no action required:

| Item | Status | Detail |
|---|---|---|
| `billing` subdomain | ✅ Exists | Created in DA for getelmer.com |
| DNS A record | ✅ Exists | `billing → 104.152.168.38` (CrocWeb nameservers) |
| SSL certificate | ✅ Active | Let's Encrypt; covers `billing.getelmer.com`; expires 2027-02-03 |
| Document root | ✅ Exists | `/domains/getelmer.com/public_html/billing/` |
| Placeholder | Present | DA default `index.html` (401 B) — will be overwritten during upload |

**DNS is managed entirely within DirectAdmin** (authoritative nameservers: `ns111d.hostwhitelabel.com` etc.). No external DNS changes are needed.

---

## Document root — IMPORTANT

The billing portal document root is a **subdirectory of the marketing site's public_html**:

```
/domains/getelmer.com/public_html/           ← marketing site root
/domains/getelmer.com/public_html/billing/   ← billing portal root (THIS IS THE TARGET)
```

This is **not** a separate vhost directory. The marketing site's root `.htaccess` is applied before the billing `.htaccess`, but it only sets no-PHP and no-directory-listing — it is compatible and does not interfere with the billing portal's rewrite rules or security headers.

Marketing site files (`index.html`, `style.css`, `privacy-policy/`, etc.) are in the **parent directory** and are not affected by uploads to `billing/`.

---

## 1. Upload portal files

Upload all files from `website/billing/` to:
`/domains/getelmer.com/public_html/billing/`

Using DA MCP `da_upload_file`:
```
da_upload_file(
  local_path = "website/billing/<file>",
  remote_dir = "/domains/getelmer.com/public_html/billing",
  remote_filename = "<file>"
)
```

Files to upload (13 files — no subdirectories, no test files):
```
.htaccess
index.html
index.js
login.html
login.js
forgot-password.html
forgot-password.js
reset-password.html
reset-password.js
subscription.html
subscription.js
common.js
style.css
```

**Do not upload:** `DEPLOY.md`, `test/`, or any other non-portal files.

---

## 2. Railway environment variables (production)

Set the following in the Railway production service **before** deploying the portal.
Redeploy the Railway service after changing variables.

| Variable | Value | Notes |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `https://billing.getelmer.com` | Restricts CORS to portal only. Currently unset (all origins allowed). |
| `BILLING_PORTAL_URL` | `https://billing.getelmer.com` | Base URL for Stripe return URLs and password reset links. |
| `RESEND_API_KEY` | `re_...` | Obtain from resend.com. **Without this, password reset emails are silently skipped.** Verify before launch: `curl https://api.getelmer.com/health` must return `"emailEnabled":true`. Railway logs also emit `[email] RESEND_API_KEY not set` on each skipped send. |
| `EMAIL_FROM` | `Elmer <noreply@notify.getelmer.com>` | Sender address. Must use the verified Resend sending domain (`notify.getelmer.com`). |
| `APP_URL` | `https://api.getelmer.com` | Already set in production. |
| `APP_SCHEME` | `elmer` | Already set in production. |

**CORS note**: After setting `CORS_ALLOWED_ORIGINS`, mobile app requests (which never send an `Origin` header) continue to work unchanged. Only browser-originated cross-origin requests are filtered.

**RESEND setup**: The domain `getelmer.com` must be verified in your Resend account before email delivery works. Add Resend's DNS records to getelmer.com in DirectAdmin.

---

## 3. Deploy backend code (Railway)

The following server-side changes must be deployed before the portal goes live:

**Files changed** (commit all to `main`, then Railway auto-deploys or trigger redeploy):
- `server/app.js` — CORS allowlist; `emailEnabled` in `/health`; `source:'web'` billing routes
- `server/db.js` — V14 migration (adds `password_reset_tokens` table; auto-runs on startup)
- `server/routes/auth.js` — `POST /auth/forgot-password`, `POST /auth/reset-password`
- `server/routes/billing.js` — `source:'web'` checkout/portal URLs; checkout-return sanitization
- `server/services/email.js` — new file; Resend email sender
- `server/package.json` + `server/package-lock.json` — `resend ^6.37.0` dependency

**V14 migration**: Adds `password_reset_tokens` table. Runs automatically on first startup after deploy. Non-destructive — no existing data affected.

---

## 4. Stripe dashboard

In the Stripe Dashboard, confirm:
- **Customer Portal** is configured (Settings → Billing → Customer portal).
  Enable: invoice history, payment method management, subscription cancellation.
- The portal return URL is set (Stripe uses the `return_url` from each session, so no static config needed).

---

## 5. Verify post-deployment

Checklist after going live:

- [ ] `https://billing.getelmer.com/` redirects to `https://billing.getelmer.com/login.html`
- [ ] Sign up creates an account and lands on the subscription dashboard
- [ ] Log in with valid credentials → subscription dashboard
- [ ] Log in with wrong password → error message (no account enumeration)
- [ ] "Forgot password" → success message shown regardless of email (no enumeration)
- [ ] Password reset email arrives (requires `RESEND_API_KEY` set)
- [ ] Reset link works exactly once; second attempt → "invalid or expired"
- [ ] "Start free trial" → Stripe Checkout opens
- [ ] Checkout cancel → returns to subscription page, banner shows "cancelled"
- [ ] Checkout success → returns, subscription shows "Trial active"
- [ ] "Manage billing" → Stripe Customer Portal opens
- [ ] Portal return → subscription page, banner shows "Billing updated"
- [ ] Sign out clears session, redirects to login
- [ ] New tab after sign out → login page (sessionStorage cleared)
- [ ] Delete account with active subscription → shows "cancel first" message
- [ ] Delete account without subscription → requires confirmation → deletes → redirects to login
- [ ] HTTPS enforced: `http://billing.getelmer.com` → 301 redirect to HTTPS
- [ ] Security headers visible in browser DevTools (HSTS, X-Frame, CSP, etc.)
- [ ] `curl https://api.getelmer.com/health` returns `"emailEnabled":true` (confirms RESEND_API_KEY is set)

---

## 6. Marketing website

**Not affected.** Marketing site files (`index.html`, `style.css`, `privacy-policy/`, `terms-and-conditions/`, etc.) are in `/domains/getelmer.com/public_html/` root. The billing portal files go into the `billing/` subdirectory. No marketing files are overwritten.

---

## Note: dual-path access

Because the billing subdomain maps to a subdirectory of `public_html`, the portal is technically accessible at both:
- `https://billing.getelmer.com/` (canonical — use this)
- `https://getelmer.com/billing/` (secondary — not advertised)

Both paths are functionally identical. Session tokens are stored in `sessionStorage` (domain-scoped) and API calls go to `https://api.getelmer.com` regardless of which host serves the page. The `noindex, nofollow` meta tag suppresses search indexing. This is acceptable for V1.

---

## Future: staging portal

If a staging portal is needed, add `https://billing-staging.getelmer.com` to
`CORS_ALLOWED_ORIGINS` on the Railway staging service:
```
CORS_ALLOWED_ORIGINS=https://billing.getelmer.com,https://billing-staging.getelmer.com
```
Point `BILLING_PORTAL_URL` to the appropriate staging URL.

---

## Future: Android Google Play Billing

The current account and entitlement architecture is fully accommodating:
- Subscriptions are tracked server-side via `subscriptions` table with `status` field
- `hasAccess()` checks status values (`trialing`, `active`, `past_due`)
- If Google Play subscriptions are added in a future phase, the webhook handler
  would populate the same `subscriptions` table rows; `hasAccess()` requires no changes
- The billing portal reads only `GET /billing/subscription` → no portal-side changes needed
