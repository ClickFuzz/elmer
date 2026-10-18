'use strict';

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const rateLimit = require('express-rate-limit');

// db initialisation happens in index.js (initDb) before createApp is called
const { requireAuth, optionalAuth }   = require('./auth');
const authRoutes                      = require('./routes/auth');
const platformRoutes                  = require('./routes/platforms');
const { createFacebookRouter }        = require('./routes/facebook');
const { createInstagramRouter }       = require('./routes/instagram');
const { createThreadsRouter }         = require('./routes/threads');

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
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

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

// Builds the CTA guidance block injected into every generation prompt.
// Keeps the publisher's URL separate from any client/subject URLs found in
// the transcript, preventing "ClickFuzz website used as Amped Electric CTA" bugs.
function buildCtaBlock({ extracted, businessInquiryUrl, businessWebsite, businessName }) {
  const publisherUrl = businessInquiryUrl || businessWebsite;
  const contentUrls  = Array.isArray(extracted.explicitUrls) ? extracted.explicitUrls : [];

  const subjectName = extracted.primarySubject || '';
  const hasDistinctSubject =
    subjectName &&
    businessName &&
    subjectName.toLowerCase() !== businessName.toLowerCase();

  const lines = ['CALL TO ACTION:'];

  if (publisherUrl) {
    lines.push(`Publisher contact URL: ${publisherUrl}`);
  }
  if (contentUrls.length > 0) {
    lines.push(`URLs mentioned in the recording: ${contentUrls.join(', ')}`);
  }
  if (hasDistinctSubject) {
    lines.push(`Note: this post is about "${subjectName}", which is distinct from the publisher "${businessName}"`);
  }

  lines.push('');
  lines.push('Rules:');

  if (hasDistinctSubject) {
    lines.push(`- Write from ${businessName}'s perspective about ${subjectName}`);
    lines.push(`- The primary CTA should send audiences to ${businessName}'s contact URL${publisherUrl ? ` (${publisherUrl})` : ''}`);
    if (contentUrls.length > 0) {
      lines.push(`- Content-specific URLs (${contentUrls.join(', ')}) may be referenced separately if contextually appropriate, but do not present them as the publisher's URL`);
    }
  } else if (publisherUrl) {
    lines.push(`- Include a relevant call to action pointing to: ${publisherUrl}`);
  }

  if (!publisherUrl && contentUrls.length === 0) {
    lines.push('- No URL is available — use a natural non-link CTA if appropriate, or omit entirely');
  }

  lines.push('- Never invent or hallucinate URLs');
  lines.push('- Do not force a CTA into appreciation posts, personal announcements, or purely informational content');
  lines.push('- Do not create duplicate CTAs');

  return lines.join('\n');
}

// ── App factory ──────────────────────────────────────────────────────────────

function createApp({ facebookRouter, instagramRouter, threadsRouter } = {}) {
  const app = express();

  // Trust first proxy when behind nginx/load balancer (needed for rate limit by real IP).
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(cors());
  app.use(express.json());

  // Warn if encryption key is missing.
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    console.warn('[elmer] CREDENTIAL_ENCRYPTION_KEY not set — credential encryption unavailable');
  }

  // ── Routes ─────────────────────────────────────────────────────────────────

  app.use('/auth',      authRateLimit, authRoutes);
  app.use('/platforms', platformRoutes);
  app.use('/facebook',  facebookRouter  ?? createFacebookRouter());
  app.use('/instagram', instagramRouter ?? createInstagramRouter());
  app.use('/threads',   threadsRouter   ?? createThreadsRouter());

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

    const businessName               = req.body.businessName               || '';
    const businessWebsite            = req.body.businessWebsite            || '';
    const businessInquiryUrl         = req.body.businessInquiryUrl         || '';
    const businessCategory           = req.body.businessCategory           || '';
    const businessDescription        = req.body.businessDescription        || '';
    const writingStyle               = req.body.writingStyle               || 'Casual / Professional';
    const customWritingInstructions  = req.body.customWritingInstructions  || '';
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

    // Step 2 — Extract content context
    let extracted = { location: null, mainService: '', specificWork: '', keyTerms: [], contentIntent: '', primarySubject: '', people: [], organizations: [], meaningfulFacts: [], explicitUrls: [], ctaHint: null };
    try {
      const extractResult = await openai.chat.completions.create({
        model:           'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You analyze recordings to extract structured context for social media content generation. Return only valid JSON.' },
          {
            role: 'user',
            content: `Analyze this recording and extract structured context.

Transcript: "${transcription || 'No audio provided.'}"
Photos: ${photoCount > 0 ? `${photoCount} photos (${classificationSummary(classifications)})` : 'none'}
Publishing business: ${businessName || 'not specified'}
Business category: ${businessCategory || 'not specified'}

Return JSON with exactly these fields:
{
  "location": { "city": "...", "state": "..." } or null,
  "contentIntent": "project update | product announcement | employee recognition | client showcase | personal update | event | educational | other",
  "primarySubject": "who or what this content is mainly about — may be a client, product, or project distinct from the publishing business",
  "mainService": "primary service, product, or topic category",
  "specificWork": "one sentence describing the primary activity or update",
  "people": ["named individuals and their role or contribution, e.g. 'Jose — installed roof tiles, recognized for work ethic'"],
  "organizations": ["companies, clients, brands, or named entities distinct from the publishing business"],
  "meaningfulFacts": ["important details, personal observations, anecdotes — include seasonal notes, compliments, humor, specific products, materials"],
  "explicitUrls": ["URLs explicitly mentioned in the transcript — only include if actually stated"],
  "ctaHint": "desired audience action from the transcript, or null",
  "keyTerms": ["4-6 relevant search terms based on actual topic, industry, and confirmed location"]
}

Rules:
- location: Only extract if explicitly stated. Never guess or invent a location.
- primarySubject: If the recording describes work for a client, the client is the subject; the publishing business is the speaker.
- meaningfulFacts: Preserve human details — personal observations, employee recognition, humor, anecdotes, seasonal notes. Do not discard non-commercial observations.
- explicitUrls: Only include URLs actually stated in the transcript.
- Do not add information absent from the transcript or business profile.`,
          },
        ],
        max_tokens:  450,
        temperature: 0.1,
      });
      extracted = safeParseJSON(extractResult.choices[0]?.message?.content ?? '{}') ?? extracted;
    } catch (err) {
      console.warn('Extraction failed, continuing without structured data:', err);
    }

    let { location, mainService, specificWork, keyTerms } = extracted;

    // GPS fallback — preserved unchanged
    if (!location && gpsCoords.length > 0 && !hasConflictingLocations(gpsCoords)) {
      location = await reverseGeocode(gpsCoords[0].lat, gpsCoords[0].lng);
    }

    const locationStr = location ? `${location.city}, ${location.state}` : 'location not specified';
    const photosCtx   = photoCount > 0 ? `Photos: ${photoCount} (${classificationSummary(classifications)}).` : '';
    const keyTermsStr = Array.isArray(keyTerms) ? keyTerms.join(', ') : '';
    const tone        = writingToneFor(writingStyle);

    const hasBeforePhoto  = classifications.includes('Before');
    const hasAfterPhoto   = classifications.includes('After');
    const hasBeforeAfter  = hasBeforePhoto && hasAfterPhoto;
    const beforeAfterRule = hasBeforeAfter
      ? '- Before and After photos are included — you may reference the transformation if it adds value'
      : '- Do NOT mention before/after comparisons, transformations, or any before/after narrative — no Before/After photos were provided';

    const customStyleCtx = customWritingInstructions.trim()
      ? `\nCustom style instructions from the business owner (follow these precisely):\n${customWritingInstructions.trim()}`
      : '';

    const bizLines = [
      businessName           && `Business: ${businessName}`,
      businessCategory       && `Industry: ${businessCategory}`,
      businessServices.length && `Services offered: ${businessServices.join(', ')}`,
      businessDescription    && `About: ${businessDescription}`,
    ].filter(Boolean).join('\n');
    const serviceAreaCtx = serviceAreasList.length ? `Service areas: ${serviceAreasList.join(', ')}` : '';

    // ── Content brief: rich extracted context for generation prompts ───────────
    const subjectName = extracted.primarySubject || '';
    const hasDistinctSubject =
      subjectName &&
      businessName &&
      subjectName.toLowerCase() !== businessName.toLowerCase();

    const contentBriefLines = [
      extracted.contentIntent                && `Content type: ${extracted.contentIntent}`,
      hasDistinctSubject                     && `Subject of this post: ${subjectName} (distinct from publisher ${businessName})`,
      extracted.mainService                  && `Primary topic/service: ${extracted.mainService}`,
      extracted.people?.length               && `People mentioned: ${extracted.people.join('; ')}`,
      extracted.organizations?.length        && `Organizations/entities mentioned: ${extracted.organizations.join(', ')}`,
      extracted.meaningfulFacts?.length      && `Key details to preserve: ${extracted.meaningfulFacts.join(' | ')}`,
      extracted.ctaHint                      && `Desired audience action: ${extracted.ctaHint}`,
      locationStr !== 'location not specified' && `Location: ${locationStr}`,
      keyTermsStr                            && `Relevant terms: ${keyTermsStr}`,
    ].filter(Boolean);
    const contentBrief = contentBriefLines.join('\n');

    // Always pass the full transcript as the primary source.
    // Structured extraction supplements but never replaces it.
    const transcriptCtx = transcription
      ? `RECORDING TRANSCRIPT (primary source — preserve the speaker's intended message and all meaningful details):\n"${transcription}"`
      : `CONTENT DESCRIPTION:\n"${specificWork || 'No description provided.'}"`;

    const ctaBlock = buildCtaBlock({ extracted, businessInquiryUrl, businessWebsite, businessName });

    // ── Prompts ────────────────────────────────────────────────────────────────

    const speakerCtx = businessName ? `${businessName}'s` : "the publisher's";

    const socialPrompt = [
      'Write a social media post.',
      '',
      transcriptCtx,
      '',
      contentBrief ? `CONTENT BRIEF:\n${contentBrief}` : '',
      photosCtx    ? `\n${photosCtx}` : '',
      bizLines     ? `\nPUBLISHING BUSINESS:\n${bizLines}` : '',
      serviceAreaCtx ? `\n${serviceAreaCtx}` : '',
      '',
      'WRITING REQUIREMENTS:',
      `- Writing tone: ${tone}${customStyleCtx}`,
      `- Write from ${speakerCtx} perspective`,
      `- ${beforeAfterRule}`,
      '- Preserve all meaningful ideas from the transcript: named people and their contributions, personal observations, anecdotes, seasonal details, humor',
      '- Improve grammar, flow, and clarity while keeping the speaker\'s voice',
      '- Match post length to the content — concise for brief updates, fuller for detailed recordings; do not pad to a word count',
      '- Use hashtags only where they feel natural — a small number or none at all',
      '- Plain text only — no markdown, no asterisks, no brackets',
      '- Do not assume every post is from a contractor or describes a completed job',
      '- Do not invent facts, quotes, testimonials, or results not in the recording',
      '- Never fabricate locations, certifications, or commercial claims',
      '',
      ctaBlock,
      '',
      'Return only the post text.',
    ].filter(s => s !== undefined).join('\n');

    const googlePrompt = [
      'Write a Google Business Profile post.',
      '',
      transcriptCtx,
      '',
      contentBrief ? `CONTENT BRIEF:\n${contentBrief}` : '',
      photosCtx    ? `\n${photosCtx}` : '',
      bizLines     ? `\nBUSINESS PROFILE:\n${bizLines}` : '',
      serviceAreaCtx ? `\n${serviceAreaCtx}` : '',
      '',
      'WRITING REQUIREMENTS:',
      `- Writing tone: ${tone}${customStyleCtx}`,
      `- ${beforeAfterRule}`,
      '- Naturally include the location when verified',
      '- Describe what happened and its value to customers',
      '- Length appropriate to the content — typically 150–300 words for substantial updates, shorter for brief announcements',
      '- Plain text only — no markdown, no brackets, no asterisks',
      '- Include 2–4 hashtags only if they add value; omit otherwise',
      '- No keyword stuffing — write for people, not search engines',
      '- Do not assume every post is from a contractor',
      '- Do not invent facts, services, or locations',
      '',
      ctaBlock,
      '',
      'Return only the post text.',
    ].filter(s => s !== undefined).join('\n');

    const wordpressPrompt = [
      'Write a blog post for WordPress.',
      '',
      transcriptCtx,
      '',
      contentBrief ? `CONTENT BRIEF:\n${contentBrief}` : '',
      photosCtx    ? `\n${photosCtx}` : '',
      bizLines     ? `\nBUSINESS PROFILE:\n${bizLines}` : '',
      serviceAreaCtx ? `\n${serviceAreaCtx}` : '',
      '',
      'WRITING REQUIREMENTS:',
      `- Writing tone: ${tone}${customStyleCtx}`,
      `- ${beforeAfterRule}`,
      '- Choose a structure appropriate to the content: project showcase, case study, product announcement, event recap, educational article, client spotlight, or other relevant format',
      '- Target at least 400 words when the content supports it — do not pad with generic filler to reach a count',
      '- Use ## and ### headings when they improve readability; do not force a fixed heading count',
      '- Preserve meaningful transcript details: named people, client work, personal observations, anecdotes',
      '- Develop explanations only where supported by the recording',
      '- Natural keyword usage — no stuffing',
      `- End with a relevant contact or CTA paragraph${businessName ? ` mentioning ${businessName}` : ''} — do not include a website URL in the article body`,
      '- No hashtags',
      '- Do not fabricate case study metrics, customer quotes, or project details not in the recording',
      '- Do not assume every post is about contractor work',
      '',
      'Return only the article with markdown headings.',
    ].filter(s => s !== undefined).join('\n');

    const seoPrompt = `Generate WordPress SEO metadata for a blog post.

Content topic: ${extracted.mainService || businessCategory || extracted.contentIntent || 'General'}
Primary subject: ${subjectName || businessName || 'not specified'}
Location: ${locationStr}
Key terms: ${keyTermsStr}
${businessName ? `Publishing business: ${businessName}\n` : ''}Photos: ${photoCount} (${classificationSummary(classifications)})
Summary: ${specificWork || transcription?.slice(0, 200) || 'No summary.'}

Return JSON with exactly these fields:
{
  "seoTitle": "50–60 chars, includes primary topic keyword + location if relevant",
  "urlSlug": "3–6 lowercase hyphenated words, no stop words",
  "metaDescription": "150–160 chars, keyword + location + compelling",
  "mainKeyword": "primary search term matching actual content",
  "secondaryKeywords": ["3–5 related terms based on actual content"],
  "imageFilenames": ["one per photo, descriptive, lowercase-hyphenated, .jpg"],
  "imageAltTexts": ["descriptive alt text for each photo"]
}

Base all fields on actual content. Never invent locations, services, or facts not in the transcript.`;

    // Step 3 — Generate all content in parallel
    try {
      const tasks    = [];
      const taskKeys = [];

      if (needsGoogle)    { tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: googlePrompt }], max_tokens: 600, temperature: 0.75 })); taskKeys.push('google'); }
      if (needsSocial)    { tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: socialPrompt }], max_tokens: 600, temperature: 0.80 })); taskKeys.push('social'); }
      if (needsWordpress) {
        tasks.push(openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: wordpressPrompt }], max_tokens: 1800, temperature: 0.72 })); taskKeys.push('wordpress');
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

module.exports = { createApp, _buildCtaBlock: buildCtaBlock, _writingToneFor: writingToneFor };
