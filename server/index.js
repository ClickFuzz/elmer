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

// Apply multer only for multipart uploads; JSON requests skip it (already parsed above).
const optionalAudioUpload = (req, res, next) => {
  const ct = req.headers['content-type'] ?? '';
  ct.includes('multipart/form-data') ? upload.single('audio')(req, res, next) : next();
};

app.get('/health', (req, res) => {
  res.json({ ok: true, aiEnabled: !!OPENAI_API_KEY });
});

app.post('/api/generate', optionalAudioUpload, async (req, res) => {
  const photoCount = parseInt(req.body.photoCount ?? '0', 10);
  const audioFile = req.file ?? null;

  let classifications = [];
  try {
    const raw = req.body.classifications;
    if (raw) classifications = JSON.parse(raw);
  } catch { /* malformed JSON — ignore */ }

  // ── Mock path ──────────────────────────────────────────────────────────
  if (!OPENAI_API_KEY) {
    if (audioFile) fs.unlink(audioFile.path, () => {});
    return res.json({
      mock: true,
      transcription:
        'Just finished installing a new 200-amp electrical panel for a homeowner in Lakewood. Old panel was completely outdated — Federal Pacific, replaced with a Square D QO panel. Customer was thrilled with the clean finish.',
      socialPost:
        "Just wrapped up a full electrical panel upgrade in Lakewood! 🔧⚡\n\nReplaced an aging Federal Pacific panel with a brand-new Square D QO 200-amp service. The old panel was a fire hazard waiting to happen — the homeowners can now rest easy with modern, code-compliant wiring.\n\nWhether you're dealing with flickering lights, tripped breakers, or just an outdated system, we're here to help. Safety first, every time.\n\n📞 Call us today for a free inspection!\n\n#ElectricalUpgrade #PanelReplacement #LakewoodContractor #HomeImprovement #ElectricalSafety",
      webContent:
        "## Electrical Panel Upgrade: Protecting a Lakewood Home with Modern Wiring\n\n[⚠️ MOCK — Connect OpenAI API key for real content]\n\nWhen you've been in the electrical business as long as we have, you start to recognize certain warning signs the moment you walk through a door. For one Lakewood family, those signs were everywhere: flickering lights in the kitchen, breakers that tripped without warning, and a basement panel that hadn't been touched since the 1970s.\n\nThe culprit? A Federal Pacific Electric (FPE) Stab-Lok panel — one of the most notoriously dangerous breaker panels ever manufactured. For decades, FPE panels have been flagged by electricians and fire marshals across the country for their tendency to fail silently. Unlike modern circuit breakers that trip reliably when overloaded, FPE breakers sometimes hold steady even under fault conditions — a hidden hazard that has caused house fires across the United States.\n\n### What We Found\n\nOur inspection revealed not just an aging FPE panel, but wiring that had been added incrementally over the years without proper planning. The panel was running out of space, with double-tapped breakers trying to support circuits that should have been independent. The service entrance was undersized for the home's current load — a growing family with two home offices, electric appliances, and the kind of modern electrical demand a 1970s panel was never designed to handle.\n\n### Our Solution: A Complete Panel Replacement\n\nWe proposed — and the homeowners approved — a full 200-amp service upgrade using a Square D QO load center. Square D QO panels are among the most trusted in the industry: built with plug-on neutral technology, making installation cleaner and reducing the chance of loose connections down the line. Every circuit was rewired to its own dedicated breaker, the double-taps were eliminated, and we added two spare slots to allow for future expansion.\n\nThe service entrance cable was upgraded to match the new 200-amp capacity, and we coordinated with the utility company for a brief power disconnect to complete the work safely.\n\n### The Finished Result\n\nWhat was once a cramped, overcrowded panel with handwritten labels is now a clean, organized, properly labeled 200-amp load center. The homeowners watched us work throughout the day and asked all the right questions — they wanted to understand what they were getting and why it mattered.\n\nBy the time we finished, the lights weren't flickering anymore. The kitchen appliances ran without tripping the circuits. And most importantly, the family could sleep without worrying about a silent electrical hazard in their basement.\n\n### Is Your Panel Overdue for an Inspection?\n\nIf your home was built before 1990 and you've never had the electrical panel inspected, now is the time. Federal Pacific, Zinsco, and early Pushmatic panels are all known problem brands. Even a modern panel that's 30+ years old may benefit from a professional review — especially if you've added major appliances, a home office, EV charging, or significant renovations.\n\nWe offer free electrical panel inspections for homeowners throughout the greater Lakewood area. Our licensed electricians will assess your current panel, identify any safety concerns, and walk you through your options — no pressure, no surprise fees.\n\n📞 Call us today to schedule your free inspection.\n🔧 Licensed, insured, and local since 1998.\n\n#ElectricalUpgrade #PanelReplacement #HomeElectrical #LicensedElectrician #LakewoodContractor",
    });
  }

  // ── Real AI path ────────────────────────────────────────────────────────
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Step 1: Transcribe audio
  let transcription = '';
  try {
    if (audioFile) {
      const renamedPath = audioFile.path + '.m4a';
      fs.renameSync(audioFile.path, renamedPath);
      const whisperResponse = await openai.audio.transcriptions.create({
        file: fs.createReadStream(renamedPath),
        model: 'whisper-1',
        language: 'en',
      });
      transcription = whisperResponse.text ?? '';
      fs.unlink(renamedPath, () => {});
    }
  } catch (err) {
    if (audioFile) fs.unlink(audioFile.path, () => {});
    console.error('Transcription error:', err);
    return res.status(500).json({ error: 'Transcription failed', detail: String(err) });
  }

  // Build photo context note
  let photoNote = '';
  if (photoCount > 0) {
    if (classifications.length === photoCount) {
      const grouped = {};
      classifications.forEach(c => { grouped[c] = (grouped[c] ?? 0) + 1; });
      const parts = Object.entries(grouped).map(([label, count]) =>
        count === 1 ? label : `${count} ${label}`
      );
      photoNote = `The contractor included ${photoCount} photo${photoCount > 1 ? 's' : ''} of the job (${parts.join(', ')}).`;
    } else {
      photoNote = `The contractor included ${photoCount} photo${photoCount > 1 ? 's' : ''} of the finished job.`;
    }
  }

  const jobDescription = transcription || '(No audio description provided.)';

  const socialPrompt = `You are a marketing copywriter helping a contractor promote their business on social media.

The contractor described their completed job:
"${jobDescription}"
${photoNote}

Write a punchy social media post suitable for Google Business Profile, Facebook, Instagram, X (Twitter), and LinkedIn. Requirements:
- 100–200 words
- Authentic, enthusiastic tone — not corporate
- Highlights the value delivered to the customer
- 3–5 relevant hashtags at the end
- Ends with a soft call to action

Return only the post text.`;

  const webPrompt = `You are a content writer helping a contractor create blog posts for their website.

The contractor described their completed job:
"${jobDescription}"
${photoNote}

Write a detailed blog post / web article for their WordPress site. Requirements:
- Minimum 500 words (aim for 600–800)
- Structured with a title (## heading) and 2–4 subheadings (### headings)
- Conversational but professional tone
- Explains what the problem was, what was done, and the result
- Includes a paragraph about why this type of work matters to homeowners
- Ends with a call to action paragraph inviting readers to contact the contractor
- 3–5 relevant hashtags at the very end

Return only the article text with markdown headings.`;

  // Step 2: Generate both post types in parallel
  try {
    const [socialResult, webResult] = await Promise.all([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: socialPrompt }],
        max_tokens: 400,
        temperature: 0.8,
      }),
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: webPrompt }],
        max_tokens: 1200,
        temperature: 0.75,
      }),
    ]);

    const socialPost = socialResult.choices[0]?.message?.content?.trim() ?? '';
    const webContent = webResult.choices[0]?.message?.content?.trim() ?? '';

    return res.json({ mock: false, transcription, socialPost, webContent });
  } catch (err) {
    console.error('Generation error:', err);
    return res.status(500).json({ error: 'Post generation failed', detail: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elmer server running on port ${PORT}`);
  console.log(`AI mode: ${OPENAI_API_KEY ? 'REAL (OpenAI)' : 'MOCK (no API key)'}`);
});
