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

if (!fs.existsSync(path.join(__dirname, 'tmp'))) {
  fs.mkdirSync(path.join(__dirname, 'tmp'));
}

// Conditionally apply multer — only for multipart uploads (audio present).
// JSON requests (no audio) are already parsed by express.json() above.
const optionalAudioUpload = (req, res, next) => {
  const ct = req.headers['content-type'] ?? '';
  if (ct.includes('multipart/form-data')) {
    upload.single('audio')(req, res, next);
  } else {
    next();
  }
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
  } catch {
    classifications = [];
  }

  if (!OPENAI_API_KEY) {
    if (audioFile) fs.unlink(audioFile.path, () => {});
    return res.json({
      mock: true,
      transcription:
        'Just finished installing a new 200-amp electrical panel for a homeowner in Lakewood. Old panel was completely outdated — federal pacific, which we replaced with a Square D QO panel. Customer was thrilled with the clean finish.',
      post:
        "Just wrapped up a full electrical panel upgrade in Lakewood! 🔧⚡\n\nReplaced an aging Federal Pacific panel with a brand-new Square D QO 200-amp service. The old panel was a fire hazard waiting to happen — the homeowners can now rest easy with modern, code-compliant wiring.\n\nWhether you're dealing with flickering lights, tripped breakers, or just an outdated system, we're here to help. Safety first, every time.\n\n📞 Call us today for a free inspection!\n\n#ElectricalUpgrade #PanelReplacement #LakewoodContractor #HomeImprovement #ElectricalSafety",
    });
  }

  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

  // Build photo description with classifications
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

  const prompt = `You are a marketing copywriter helping a contractor promote their business on social media.

The contractor described their completed job as follows:
"${transcription || '(No audio description provided.)'}"
${photoNote}

Write a polished, enthusiastic social media post for this job. The post should:
- Sound authentic and professional, not corporate
- Include 2–4 relevant hashtags at the end
- Be suitable for Google Business Profile, Facebook, or Instagram
- Be 100–200 words
- Highlight the value delivered to the customer
- End with a soft call to action

Return only the post text, no extra commentary.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.8,
    });
    const post = completion.choices[0]?.message?.content?.trim() ?? '';
    return res.json({ mock: false, transcription, post });
  } catch (err) {
    console.error('Generation error:', err);
    return res.status(500).json({ error: 'Post generation failed', detail: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elmer server running on port ${PORT}`);
  console.log(`AI mode: ${OPENAI_API_KEY ? 'REAL (OpenAI)' : 'MOCK (no API key)'}`);
});
