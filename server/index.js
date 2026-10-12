'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT ?? 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: path.join(__dirname, 'tmp') });
if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'));

const optionalAudioUpload = (req, res, next) => {
  const ct = req.headers['content-type'] ?? '';
  ct.includes('multipart/form-data') ? upload.single('audio')(req, res, next) : next();
};

app.get('/health', (req, res) => {
  res.json({ ok: true, aiEnabled: !!OPENAI_API_KEY });
});

// ── Mock payload ────────────────────────────────────────────────────────────
const MOCK_RESPONSE = {
  mock: true,
  transcription:
    'Just finished installing a new 200-amp electrical panel for a homeowner in Lakewood. Old panel was completely outdated — Federal Pacific, replaced with a Square D QO panel. Customer was thrilled with the clean finish.',
  location: { city: 'Lakewood', state: 'CO' },
  mainService: 'Electrical',
  googlePost:
    "Electrical panel replacement complete in Lakewood, CO. ⚡\n\nWe safely removed a failing Federal Pacific Stab-Lok panel and installed a new Square D QO 200-amp service — one of the most reliable load centers available for residential use.\n\nFederal Pacific panels are a well-documented fire hazard. If your Lakewood home still has the original panel from the 1970s–90s, a free inspection is worth your time.\n\nOur licensed electricians serve Lakewood, Wheat Ridge, Arvada, and Jefferson County. All panel work is fully permitted and inspected.\n\n✅ Free panel inspections\n✅ Same-day estimates\n✅ Licensed & insured\n\n📞 Call or text to schedule.\n\n#LakewoodElectrician #ElectricalPanel #PanelReplacement #JeffersonCounty",
  socialPost:
    "Before and after you can feel confident about. 🔌\n\nA Lakewood homeowner called us about flickering lights and breakers that kept tripping. One look at the panel told us everything — Federal Pacific Stab-Lok, a brand flagged by fire marshals for decades.\n\nWhat we installed:\n✅ Square D QO 200-amp load center\n✅ Every circuit on its own dedicated breaker\n✅ Clean, labeled, permitted, and inspected\n\nThe homeowners had no idea how serious the problem was until we showed them. Now they do — and they can sleep easier.\n\nIf your home is 30+ years old and you've never had the panel checked, message us. Free inspections, no pressure.\n\n#BeforeAndAfter #HomeImprovement #ElectricalUpgrade #LicensedElectrician #LakewoodCO",
  webContent:
    "## Electrical Panel Replacement in Lakewood, CO: Replacing a Federal Pacific Hazard\n\n[⚠️ MOCK — Connect OpenAI API key for real content]\n\nWhen a Lakewood homeowner reached out about flickering lights and breakers that kept tripping, we knew this was more than routine maintenance. One visit to the basement confirmed our suspicion: a Federal Pacific Electric Stab-Lok panel — one of the most widely flagged electrical hazards in American residential housing.\n\n### Why Federal Pacific Panels Are a Problem\n\nFederal Pacific Electric manufactured millions of Stab-Lok breaker panels between the 1950s and 1980s. Unlike modern circuit breakers, Stab-Lok breakers are known to fail silently under fault conditions — meaning they may not trip when they should. This failure mode has been linked to residential fires across the country. If your home was built before 1990 and still has its original panel, there's a real chance you have one.\n\nThe warning signs are often subtle: lights that flicker for no clear reason, breakers that trip more often than they should, or a panel that feels warm to the touch. By the time homeowners notice these symptoms, the risk is already present.\n\n### What We Did in Lakewood\n\nFor this job, we performed a complete panel replacement — not a partial fix. The work included:\n\n- Removing the Federal Pacific Stab-Lok panel entirely\n- Installing a Square D QO 200-amp load center, a top-rated residential panel known for its plug-on neutral design and long-term reliability\n- Assigning every circuit to its own dedicated breaker, eliminating the double-tapped breakers that had accumulated over the years\n- Upgrading the service entrance to match the new 200-amp capacity\n- Coordinating with the utility company for a brief service disconnect\n- Completing a full inspection and obtaining the required permit\n\nThe finished panel is clean, clearly labeled, and has room to spare for future additions like EV charging or a workshop circuit.\n\n### The Result: Peace of Mind\n\nThe homeowners watched the process from start to finish and asked great questions throughout. By the end of the day, the flickering lights were gone, the breakers were holding steady, and the family had a panel that meets modern electrical code.\n\nMore than anything else, they told us they felt relieved. Knowing your home's electrical system is safe — not just functional — is worth more than the cost of the upgrade.\n\n### Is Your Panel Overdue for an Inspection?\n\nFederal Pacific and Zinsco panels are the most common problem brands, but any panel more than 30 years old deserves a professional look — especially if you've added major appliances, a home office, EV charging, or renovations since it was installed.\n\nWe offer free electrical panel inspections throughout Lakewood, Wheat Ridge, Arvada, and Jefferson County. Our licensed electricians will assess your current setup, explain your options clearly, and never pressure you into work you don't need.\n\n📞 Call or text us to schedule your free inspection. Licensed, insured, and local since 1998.\n\n#ElectricalPanelReplacement #LakewoodCO #FederalPacificPanel #LicensedElectrician #JeffersonCounty",
  seoMetadata: {
    seoTitle: 'Electrical Panel Replacement in Lakewood, CO | [Your Business]',
    urlSlug: 'electrical-panel-replacement-lakewood-co',
    metaDescription:
      'Our licensed team replaced a failing Federal Pacific panel with a new 200-amp Square D service in Lakewood, CO. Free inspections available. Call today.',
    mainKeyword: 'electrical panel replacement Lakewood CO',
    secondaryKeywords: [
      'Federal Pacific panel replacement',
      '200-amp service upgrade Lakewood',
      'licensed electrician Jefferson County',
      'Stab-Lok panel replacement',
    ],
    imageFilenames: [
      'federal-pacific-panel-before-lakewood-co.jpg',
      'square-d-200-amp-panel-installed-lakewood.jpg',
    ],
    imageAltTexts: [
      'Old Federal Pacific electrical panel before replacement in Lakewood CO home',
      'New Square D QO 200-amp panel installed by licensed electrician in Lakewood Colorado',
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function classificationSummary(classifications) {
  if (!classifications.length) return 'no photos';
  const grouped = {};
  classifications.forEach(c => { grouped[c] = (grouped[c] ?? 0) + 1; });
  return Object.entries(grouped)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');
}

function safeParseJSON(raw) {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
app.post('/api/generate', optionalAudioUpload, async (req, res) => {
  const photoCount = parseInt(req.body.photoCount ?? '0', 10);
  const audioFile = req.file ?? null;

  let classifications = [];
  try {
    const raw = req.body.classifications;
    if (raw) classifications = JSON.parse(raw);
  } catch { /* ignore */ }

  if (!OPENAI_API_KEY) {
    if (audioFile) fs.unlink(audioFile.path, () => {});
    return res.json(MOCK_RESPONSE);
  }

  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // ── Step 1: Transcribe ─────────────────────────────────────────────────────
  let transcription = '';
  try {
    if (audioFile) {
      const renamedPath = audioFile.path + '.m4a';
      fs.renameSync(audioFile.path, renamedPath);
      const result = await openai.audio.transcriptions.create({
        file: fs.createReadStream(renamedPath),
        model: 'whisper-1',
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

  // ── Step 2: Extract job info (location, service, key terms) ───────────────
  let extracted = { location: null, mainService: '', specificWork: '', keyTerms: [] };
  try {
    const extractResult = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You extract structured job information from contractor descriptions. Return only valid JSON.',
        },
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
      max_tokens: 300,
      temperature: 0.1,
    });
    extracted = safeParseJSON(extractResult.choices[0]?.message?.content ?? '{}') ?? extracted;
  } catch (err) {
    console.warn('Extraction failed, continuing without structured data:', err);
  }

  const { location, mainService, specificWork, keyTerms } = extracted;
  const locationStr = location ? `${location.city}, ${location.state}` : 'location not specified';
  const photosCtx = photoCount > 0 ? `Photos: ${photoCount} (${classificationSummary(classifications)}).` : '';
  const keyTermsStr = Array.isArray(keyTerms) ? keyTerms.join(', ') : '';
  const jobDesc = specificWork || transcription || 'Job description not provided.';

  // ── Step 3: Generate all content in parallel ───────────────────────────────
  const googlePrompt = `Write a Google Business Profile post for a contractor.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}
Key terms: ${keyTermsStr}

Requirements:
- 150–300 words
- Professional, trustworthy tone
- Naturally mention the city/area
- Describe what was done and the customer benefit
- Clear call to action
- 2–4 hashtags at the end
- No keyword stuffing — write for people, not search engines
Return only the post text.`;

  const socialPrompt = `Write a social media post for Facebook, Instagram, X (Twitter), and LinkedIn.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}
Key terms: ${keyTermsStr}

Requirements:
- 100–200 words
- Conversational, authentic, story-driven
- If before/after photos are indicated, use that as the narrative frame (never assume before/after from upload order alone)
- Emotionally engaging — what did this mean for the customer?
- Call to action
- 3–5 hashtags at the end
Return only the post text.`;

  const wordpressPrompt = `Write a contractor blog post for WordPress.

Job: ${jobDesc}
Location: ${locationStr}
${photosCtx}
Main service: ${mainService || 'Contracting'}
Key terms: ${keyTermsStr}

Requirements:
- 600–900 words minimum
- Title (## heading) + 3–4 subheadings (### headings)
- Educate readers about why this type of work matters
- Natural keyword usage — never keyword-stuff
- Professional, helpful tone
- Ends with a contact/CTA paragraph
- No hashtags
Return only the article with markdown headings.`;

  const seoPrompt = `Generate WordPress SEO metadata for a contractor blog post.

Job: ${jobDesc}
Location: ${locationStr}
Main service: ${mainService || 'Contracting'}
Key terms: ${keyTermsStr}
Photos: ${photoCount} (${classificationSummary(classifications)})

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

  try {
    const [googleResult, socialResult, wpResult, seoResult] = await Promise.all([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: googlePrompt }],
        max_tokens: 450,
        temperature: 0.75,
      }),
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: socialPrompt }],
        max_tokens: 400,
        temperature: 0.8,
      }),
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: wordpressPrompt }],
        max_tokens: 1400,
        temperature: 0.72,
      }),
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You generate SEO metadata as JSON.' },
          { role: 'user', content: seoPrompt },
        ],
        max_tokens: 600,
        temperature: 0.3,
      }),
    ]);

    const googlePost = googleResult.choices[0]?.message?.content?.trim() ?? '';
    const socialPost = socialResult.choices[0]?.message?.content?.trim() ?? '';
    const webContent = wpResult.choices[0]?.message?.content?.trim() ?? '';
    const seoMetadata = safeParseJSON(seoResult.choices[0]?.message?.content ?? '{}') ?? {};

    return res.json({
      mock: false,
      transcription,
      location,
      mainService,
      googlePost,
      socialPost,
      webContent,
      seoMetadata,
    });
  } catch (err) {
    console.error('Generation error:', err);
    return res.status(500).json({ error: 'Content generation failed', detail: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elmer server running on port ${PORT}`);
  console.log(`AI mode: ${OPENAI_API_KEY ? 'REAL (OpenAI)' : 'MOCK (no API key)'}`);
});
