'use strict';

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const { getDb, cleanExpiredSessions } = require('./db');
const { requireAuth, optionalAuth }   = require('./auth');
const authRoutes                      = require('./routes/auth');
const platformRoutes                  = require('./routes/platforms');
const { createFacebookRouter }        = require('./routes/facebook');

// ── Rate limiters ────────────────────────────────────────────────────────────

const DISABLE_RATE_LIMIT = process.env.DISABLE_RATE_LIMIT === 'true';

function makeLimit(opts) {
  if (DISABLE_RATE_LIMIT) return (_req, _res, next) => next();
  return rateLimit({
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Too many requests, please try again later.' },
    ...opts,
  });
}

const generateRateLimit = makeLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.GENERATE_RATE_LIMIT ?? '10', 10),
});

const authRateLimit = makeLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT ?? '20', 10),
});

// ── Auth selection for /api/generate ─────────────────────────────────────────
// DISABLE_AUTH=true keeps the endpoint open for mobile clients that have not
// yet been updated to send Bearer tokens (Phase 2 will add auth to the app).
const DISABLE_AUTH = process.env.DISABLE_AUTH === 'true';

if (DISABLE_AUTH && process.env.NODE_ENV === 'production') {
  throw new Error('[elmer] DISABLE_AUTH=true is not allowed in production. Remove it from your environment.');
}

const generateAuth = DISABLE_AUTH ? optionalAuth : requireAuth;

if (DISABLE_AUTH) {
  console.warn('[elmer] DISABLE_AUTH=true — /api/generate accepts unauthenticated requests');
}

// ── Multer upload ─────────────────────────────────────────────────────────────

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
const upload = multer({ dest: TMP_DIR });

const optionalAudioUpload = (req, res, next) => {
  const ct = req.headers['content-type'] ?? '';
  ct.includes('multipart/form-data') ? upload.single('audio')(req, res, next) : next();
};

// ── Mock payload (returned when OPENAI_API_KEY is absent) ──────────────────────

const MOCK_RESPONSE = {
  mock: true,
  transcription:
    'Just finished installing a new 200-amp electrical panel for a homeowner in Lakewood. Old panel was completely outdated — Federal Pacific, replaced with a Square D QO panel. Customer was thrilled with the clean finish.',
  location:    { city: 'Lakewood', state: 'CO' },
  mainService: 'Electrical',
  googlePost:
    'Electrical panel replacement complete in Lakewood, CO. ⚡\n\nWe safely removed a failing Federal Pacific Stab-Lok panel and installed a new Square D QO 200-amp service — one of the most reliable load centers available for residential use.\n\nFederal Pacific panels are a well-documented fire hazard. If your Lakewood home still has the original panel from the 1970s–90s, a free inspection is worth your time.\n\nOur licensed electricians serve Lakewood, Wheat Ridge, Arvada, and Jefferson County. All panel work is fully permitted and inspected.\n\n✅ Free panel inspections\n✅ Same-day estimates\n✅ Licensed & insured\n\n📞 Call or text to schedule.\n\n#LakewoodElectrician #ElectricalPanel #PanelReplacement #JeffersonCounty',
  socialPost:
    'Before and after you can feel confident about. 🔌\n\nA Lakewood homeowner called us about flickering lights and breakers that kept tripping. One look at the panel told us everything — Federal Pacific Stab-Lok, a brand flagged by fire marshals for decades.\n\nWhat we installed:\n✅ Square D QO 200-amp load center\n✅ Every circuit on its own dedicated breaker\n✅ Clean, labeled, permitted, and inspected\n\nThe homeowners had no idea how serious the problem was until we showed them. Now they do — and they can sleep easier.\n\nIf your home is 30+ years old and you\'ve never had the panel checked, message us. Free inspections, no pressure.\n\n#BeforeAndAfter #HomeImprovement #ElectricalUpgrade #LicensedElectrician #LakewoodCO',
  webContent:
    '## Electrical Panel Replacement in Lakewood, CO: Replacing a Federal Pacific Hazard\n\n[⚠️ MOCK — Connect OpenAI API key for real content]',
  seoMetadata: {
    seoTitle:           'Electrical Panel Replacement in Lakewood, CO | [Your Business]',
    urlSlug:            'electrical-panel-replacement-lakewood-co',
    metaDescription:    'Our licensed team replaced a failing Federal Pacific panel with a new 200-amp Square D service in Lakewood, CO. Free inspections available. Call today.',
    mainKeyword:        'electrical panel replacement Lakewood CO',
    secondaryKeywords:  ['Federal Pacific panel replacement', '200-amp service upgrade Lakewood'],
    imageFilenames:     ['federal-pacific-panel-before-lakewood-co.jpg', 'square-d-200-amp-panel-installed-lakewood.jpg'],
    imageAltTexts:      ['Old Federal Pacific panel before replacement', 'New Square D QO panel installed'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function haversineKm(a, b) {
  const R    = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h    = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function hasConflictingLocations(coords) {
  for (let i = 0; i < coords.length; i++)
    for (let j = i + 1; j < coords.length; j++)
      if (haversineKm(coords[i], coords[j]) > 50) return true;
  return false;
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ElmerApp/1.0 (contractor-posting-assistant)' } });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address ?? {};
    const city = addr.city || addr.town || addr.village || addr.county;
    const state = addr.state;
    if (city && state) return { city, state };
  } catch (err) {
    console.warn('Reverse geocode failed:', err.message);
  }
  return null;
}

function writingToneFor(style) {
  const map = {
    'Professional':            'formal and authoritative',
    'Casual / Professional':   'friendly yet professional',
    'Friendly & Conversational': 'warm and conversational',
    'Straightforward':         'direct and concise — no filler',
    'Confident & Bold':        'confident and results-focused',
    'Storytelling':            'narrative-driven with a clear story arc',
    'Playful & Lighthearted':  'upbeat and lighthearted',
  };
  return map[style] || 'friendly yet professional';
}

function classificationSummary(classifications) {
  if (!classifications.length) return 'no photos';
  const grouped = {};
  classifications.forEach(c => { grouped[c] = (grouped[c] ?? 0) + 1; });
  return Object.entries(grouped).map(([label, count]) => `${count} ${label}`).join(', ');
}

function safeParseJSON(raw) {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ── App factory ──────────────────────────────────────────────────────────────

function createApp({ facebookRouter } = {}) {
  const app = express();

  // Trust first proxy when behind nginx/load balancer (needed for rate limit by real IP).
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(cors());
  app.use(express.json());

  // Clean stale sessions on startup.
  try { cleanExpiredSessions(getDb()); } catch { /* non-fatal */ }

  // Warn if encryption key is missing.
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    console.warn('[elmer] CREDENTIAL_ENCRYPTION_KEY not set — credential encryption unavailable');
  }

  // ── Routes ─────────────────────────────────────────────────────────────────

  app.use('/auth',      authRateLimit, authRoutes);
  app.use('/platforms', platformRoutes);
  app.use('/facebook',  facebookRouter ?? createFacebookRouter());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, aiEnabled: !!process.env.OPENAI_API_KEY });
  });

  // ── POST /api/generate ─────────────────────────────────────────────────────

  app.post('/api/generate', generateRateLimit, generateAuth, optionalAudioUpload, async (req, res) => {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const photoCount     = parseInt(req.body.photoCount ?? '0', 10);
    const audioFile      = req.file ?? null;

    let classifications = [];
    try { if (req.body.classifications) classifications = JSON.parse(req.body.classifications); } catch { /* ignore */ }

    let gpsCoords = [];
    try {
      const raw = req.body.gpsCoords;
      if (Array.isArray(raw))       gpsCoords = raw;
      else if (typeof raw === 'string') gpsCoords = JSON.parse(raw);
    } catch { /* ignore */ }

    const businessName        = req.body.businessName        || '';
    const businessWebsite     = req.body.businessWebsite     || '';
    const businessCategory    = req.body.businessCategory    || '';
    const businessDescription = req.body.businessDescription || '';
    const writingStyle        = req.body.writingStyle        || 'Casual / Professional';
    let businessServices = [];
    let serviceAreasList = [];
    try {
      const raw = req.body.businessServices;
      if (Array.isArray(raw)) businessServices = raw;
      else if (typeof raw === 'string') businessServices = JSON.parse(raw);
    } catch { /* ignore */ }
    try {
      const raw = req.body.serviceAreas;
      if (Array.isArray(raw)) serviceAreasList = raw;
      else if (typeof raw === 'string') serviceAreasList = JSON.parse(raw);
    } catch { /* ignore */ }

    let platforms = ['social'];
    try {
      const raw = req.body.platforms;
      if (typeof raw === 'string')  platforms = JSON.parse(raw);
      else if (Array.isArray(raw))  platforms = raw;
    } catch { /* ignore */ }
    const needsGoogle    = platforms.includes('google');
    const needsSocial    = platforms.includes('social');
    const needsWordpress = platforms.includes('wordpress');

    if (!OPENAI_API_KEY) {
      if (audioFile) fs.unlink(audioFile.path, () => {});
      return res.json(MOCK_RESPONSE);
    }

    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Step 1 — Transcribe
    let transcription = '';
    try {
      if (audioFile) {
        const renamedPath = audioFile.path + '.m4a';
        fs.renameSync(audioFile.path, renamedPath);
        const result = await openai.audio.transcriptions.create({
          file:     fs.createReadStream(renamedPath),
          model:    'whisper-1',
          language: 'en',
        });
        transcription = result.text ?? '';
        fs.unlink(renamedPath, () => {});
      }
    } catch (err) {
      if (audioFile) fs.unlink(audioFile.path, () => {});
      console.error('Transcription error:', err);
      return res.status(500).json({ error: 'Transcription failed', detail: String(err) });
    }

    // Step 2 — Extract job info
    let extracted = { location: null, mainService: '', specificWork: '', keyTerms: [] };
    try {
      const extractResult = await openai.chat.completions.create({
        model:           'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You extract structured job information from contractor descriptions. Return only valid JSON.' },
          {
            role: 'user',
            content: `Extract information from this contractor job description.

Description: "${transcription || 'No audio provided.'}"
Photos: ${photoCount > 0 ? `${photoCount} photos (${classificationSummary(classifications)})` : 'none'}

Return JSON with exactly these fields:
{
  "location": { "city": "...", "state": "..." } or null,
  "mainService": "service category (e.g. Electrical, Roofing, Plumbing)",
  "specificWork": "one sentence describing exactly what was done",
  "keyTerms": ["3-5 specific search terms a local customer would use"]
}

Rules:
- location: Only extract if explicitly stated. Never guess or invent a location.
- keyTerms: Be specific and local (include city/region if location is known).`,
          },
        ],
        max_tokens:  300,
        temperature: 0.1,
      });
      extracted = safeParseJSON(extractResult.choices[0]?.message?.content ?? '{}') ?? extracted;
    } catch (err) {
      console.warn('Extraction failed, continuing without structured data:', err);
    }

    let { location, mainService, specificWork, keyTerms } = extracted;

    // GPS fallback
    if (!location && gpsCoords.length > 0 && !hasConflictingLocations(gpsCoords)) {
      location = await reverseGeocode(gpsCoords[0].lat, gpsCoords[0].lng);
    }

    const locationStr  = location ? `${location.city}, ${location.state}` : 'location not specified';
    const photosCtx    = photoCount > 0 ? `Photos: ${photoCount} (${classificationSummary(classifications)}).` : '';
    const keyTermsStr  = Array.isArray(keyTerms) ? keyTerms.join(', ') : '';
    const jobDesc      = specificWork || transcription || 'Job description not provided.';
    const tone         = writingToneFor(writingStyle);
    const neverInvent  = 'Never invent services, job details, or claim this job occurred in a service area not confirmed by the description.';

    const bizLines = [
      businessName        && `Business: ${businessName}`,
      businessCategory    && `Industry: ${businessCategory}`,
      businessServices.length && `Services offered: ${businessServices.join(', ')}`,
      businessDescription && `About: ${businessDescription}`,
    ].filter(Boolean).join('\n');
    const serviceAreaCtx = serviceAreasList.length ? `Service areas: ${serviceAreasList.join(', ')}` : '';

    const googlePrompt = `Write a Google Business Profile post for a contractor.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}Key terms: ${keyTermsStr}
${bizLines ? bizLines + '\n' : ''}${serviceAreaCtx ? serviceAreaCtx + '\n' : ''}
Requirements:
- 150–300 words
- Writing tone: ${tone}
- Naturally mention the city/area
- Describe what was done and the customer benefit
- Clear call to action${businessName ? ` — invite readers to contact ${businessName}` : ''}${businessWebsite ? ` and visit ${businessWebsite} (bare URL, plain text, no markdown)` : ''}
- Plain text only — no markdown, no brackets, no asterisks
- 2–4 hashtags at the end
- No keyword stuffing — write for people, not search engines
- ${neverInvent}
Return only the post text.`;

    const socialPrompt = `Write a social media post for Facebook, Instagram, X (Twitter), and LinkedIn.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}Key terms: ${keyTermsStr}
${businessName ? `Business: ${businessName}\n` : ''}
Requirements:
- 100–200 words
- Writing tone: ${tone}
- If before/after photos are indicated, use that as the narrative frame (never assume before/after from upload order alone)
- Emotionally engaging — what did this mean for the customer?
- Call to action${businessWebsite ? ` — include the bare URL ${businessWebsite} (plain text, no markdown)` : ''}
- 3–5 hashtags at the end
- Plain text only — no markdown, no brackets, no asterisks
- ${neverInvent}
Return only the post text.`;

    const wordpressPrompt = `Write a contractor blog post for WordPress.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}Main service: ${mainService || businessCategory || 'Contracting'}
Key terms: ${keyTermsStr}
${bizLines ? bizLines + '\n' : ''}${serviceAreaCtx ? serviceAreaCtx + '\n' : ''}
Requirements:
- 600–900 words minimum
- Title (## heading) + 3–4 subheadings (### headings)
- Writing tone: ${tone}
- Educate readers about why this type of work matters
- Natural keyword usage — never keyword-stuff
- Ends with a contact/CTA paragraph${businessName ? ` mentioning ${businessName}` : ''} — do not include any website URL in the article
- No hashtags
- ${neverInvent}
Return only the article with markdown headings.`;

    const seoPrompt = `Generate WordPress SEO metadata for a contractor blog post.

Job: ${jobDesc}
Location: ${locationStr}
Main service: ${mainService || businessCategory || 'Contracting'}
Key terms: ${keyTermsStr}
${businessName ? `Business name: ${businessName}\n` : ''}Photos: ${photoCount} (${classificationSummary(classifications)})

Return JSON with exactly these fields:
{
  "seoTitle": "50–60 chars, includes main keyword + location",
  "urlSlug": "3–6 lowercase hyphenated words, no stop words",
  "metaDescription": "150–160 chars, keyword + location + compelling",
  "mainKeyword": "primary local search term",
  "secondaryKeywords": ["3–5 related terms"],
  "imageFilenames": ["one per photo, descriptive, lowercase-hyphenated, .jpg"],
  "imageAltTexts": ["descriptive alt text for each photo"]
}

Never invent job details or locations not mentioned in the description.`;

    // Step 3 — Generate all content in parallel
    try {
      const tasks    = [];
      const taskKeys = [];

      if (needsGoogle)    { tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: googlePrompt }], max_tokens: 450, temperature: 0.75 })); taskKeys.push('google'); }
      if (needsSocial)    { tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: socialPrompt }], max_tokens: 400, temperature: 0.80 })); taskKeys.push('social'); }
      if (needsWordpress) {
        tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: wordpressPrompt }], max_tokens: 1400, temperature: 0.72 })); taskKeys.push('wordpress');
        tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You generate SEO metadata as JSON.' }, { role: 'user', content: seoPrompt }], max_tokens: 600, temperature: 0.3 })); taskKeys.push('seo');
      }

      const results = await Promise.all(tasks);
      const r = {};
      taskKeys.forEach((key, i) => { r[key] = results[i]; });

      return res.json({
        mock:        false,
        transcription,
        location,
        mainService,
        googlePost:  r.google?.choices[0]?.message?.content?.trim()  ?? '',
        socialPost:  r.social?.choices[0]?.message?.content?.trim()  ?? '',
        webContent:  r.wordpress?.choices[0]?.message?.content?.trim() ?? '',
        seoMetadata: r.seo ? (safeParseJSON(r.seo.choices[0]?.message?.content ?? '{}') ?? {}) : null,
      });
    } catch (err) {
      console.error('Generation error:', err);
      return res.status(500).json({ error: 'Content generation failed', detail: String(err) });
    }
  });

  // ── Global error handler ───────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[elmer] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
