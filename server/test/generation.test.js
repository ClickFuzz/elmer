'use strict';

// Set env before any requires
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.DISABLE_AUTH              = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { closeDb }          = require('../db');
const { _buildCtaBlock, _writingToneFor } = require('../app');

// ── OpenAI mock ───────────────────────────────────────────────────────────────
//
// Installed into require.cache before the app handles each request.
// app.js calls require('openai') lazily inside the route handler, so it picks
// up our mock from the cache on every request.

const OPENAI_RESOLVE = require.resolve('openai');

function installOpenAIMock({ extractionResult = {}, generatedText = 'Generated post content.', transcribedText = '' } = {}) {
  const calls = [];

  class MockOpenAI {
    constructor() {
      this.audio = {
        transcriptions: {
          create: async () => ({ text: transcribedText }),
        },
      };
      this.chat = {
        completions: {
          create: async (opts) => {
            calls.push(JSON.parse(JSON.stringify(opts)));
            if (opts.response_format?.type === 'json_object') {
              // Distinguish extraction call (has "Analyze this recording") from SEO call
              const isSeo = opts.messages?.some(m =>
                typeof m.content === 'string' && m.content.includes('seoTitle')
              );
              if (isSeo) {
                return { choices: [{ message: { content: JSON.stringify({
                  seoTitle: 'Test Title',
                  urlSlug: 'test-slug',
                  metaDescription: 'Test description.',
                  mainKeyword: 'test',
                  secondaryKeywords: ['test'],
                  imageFilenames: [],
                  imageAltTexts: [],
                }) } }] };
              }
              return { choices: [{ message: { content: JSON.stringify(extractionResult) } }] };
            }
            return { choices: [{ message: { content: generatedText } }] };
          },
        },
      };
    }
  }

  require.cache[OPENAI_RESOLVE] = { exports: MockOpenAI };
  return calls;
}

function uninstallOpenAIMock() {
  delete require.cache[OPENAI_RESOLVE];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function promptsContaining(calls, text) {
  return calls.some(call =>
    call.messages?.some(m => typeof m.content === 'string' && m.content.includes(text))
  );
}

function dummyAudioBuffer() {
  // Minimal non-empty buffer so multer saves a file and the handler proceeds
  return require('buffer').Buffer.from('FAKE_AUDIO');
}

// ── App setup ─────────────────────────────────────────────────────────────────

let app;

before(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await setupFreshTestDb();
  const { createApp } = require('../app');
  app = createApp();
});

after(async () => {
  uninstallOpenAIMock();
  delete process.env.OPENAI_API_KEY;
  await closeDb();
});

beforeEach(() => {
  uninstallOpenAIMock();
});

// ── Test A — Employee recognition ─────────────────────────────────────────────

describe('Test A — Employee recognition', () => {
  it('preserves named employee and recognition in the generation prompt', async () => {
    const transcript = "We did a roof and Jose did a great job putting down the tiles. He's a hard worker.";
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'project update',
        primarySubject: 'roofing project',
        mainService: 'Roofing',
        specificWork: 'Completed a roof installation.',
        people: ['Jose — installed roof tiles, recognized as a hard worker'],
        organizations: [],
        meaningfulFacts: ['Jose installed roof tiles', 'Jose is recognized as a hard worker'],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: ['roofing', 'roof installation'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    // Full transcript must appear in the generation prompt
    assert.ok(promptsContaining(calls, transcript), 'generation prompt should include the full transcript');
    // Jose's name must appear (from transcript or content brief)
    assert.ok(promptsContaining(calls, 'Jose'), 'generation prompt should reference Jose');
    // "hard worker" detail must appear
    assert.ok(promptsContaining(calls, 'hard worker'), 'generation prompt should include hard worker recognition');
  });
});

// ── Test B — Personal observation ─────────────────────────────────────────────

describe('Test B — Personal observation (trees)', () => {
  it('preserves seasonal observation unrelated to the service', async () => {
    const transcript = 'We finished a job in Aspen. The trees look amazing this time of year.';
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: { city: 'Aspen', state: 'CO' },
        contentIntent: 'project update',
        primarySubject: 'job in Aspen',
        mainService: 'General',
        specificWork: 'Finished a job in Aspen.',
        people: [],
        organizations: [],
        meaningfulFacts: ['trees look amazing this time of year', 'seasonal observation'],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: ['Aspen', 'job'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(promptsContaining(calls, transcript), 'generation prompt should include the full transcript');
    // The tree observation must reach the generation prompt
    assert.ok(
      promptsContaining(calls, 'trees') || promptsContaining(calls, 'amazing'),
      'generation prompt should preserve the tree/seasonal observation'
    );
  });
});

// ── Test C — Agency / client distinction ──────────────────────────────────────

describe('Test C — Agency/client distinction', () => {
  it('keeps publisher URL separate from client URL in the CTA block', async () => {
    const transcript = "We just launched a new website for Amped Electric at ampedelectric.com.";
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'client showcase',
        primarySubject: 'Amped Electric',
        mainService: 'Web design',
        specificWork: 'Launched a new website for Amped Electric.',
        people: [],
        organizations: ['Amped Electric'],
        meaningfulFacts: ['new website launched for Amped Electric'],
        explicitUrls: ['ampedelectric.com'],
        ctaHint: null,
        keyTerms: ['web design', 'website launch'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('businessName', 'ClickFuzz Digital Marketing')
      .field('businessWebsite', 'clickfuzz.com')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    // The social prompt must distinguish ClickFuzz from Amped Electric
    assert.ok(promptsContaining(calls, 'Amped Electric'), 'prompt should reference the client');
    assert.ok(promptsContaining(calls, 'ClickFuzz'), 'prompt should reference the publisher');
    // The CTA block must label clickfuzz.com as the publisher contact URL
    assert.ok(
      promptsContaining(calls, 'clickfuzz.com') && promptsContaining(calls, 'Publisher contact URL'),
      'prompt should identify clickfuzz.com as the publisher contact URL'
    );
    // ampedelectric.com must be flagged as a content URL, not the publisher URL
    assert.ok(
      promptsContaining(calls, 'ampedelectric.com') && promptsContaining(calls, 'URLs mentioned in the recording'),
      'prompt should correctly identify ampedelectric.com as a content-specific URL'
    );
  });

  it('buildCtaBlock: does not substitute client URL as publisher CTA', () => {
    const block = _buildCtaBlock({
      extracted: {
        primarySubject: 'Amped Electric',
        explicitUrls: ['ampedelectric.com'],
        organizations: ['Amped Electric'],
      },
      businessInquiryUrl: '',
      businessWebsite: 'clickfuzz.com',
      businessName: 'ClickFuzz Digital Marketing',
    });

    assert.ok(block.includes('Publisher contact URL: clickfuzz.com'), 'publisher URL correctly labelled');
    assert.ok(block.includes('ampedelectric.com'), 'client URL preserved in block');
    assert.ok(block.includes('distinct from the publisher'), 'subject/publisher distinction stated');
    assert.ok(!block.includes('Never invent or hallucinate URLs\n- Publisher contact URL: ampedelectric.com'), 'client URL is not the publisher CTA');
  });
});

// ── Test D — Ecommerce with anecdote ──────────────────────────────────────────

describe('Test D — Ecommerce with personal anecdote', () => {
  it('preserves personal anecdote alongside product announcement', async () => {
    const transcript = "We just launched our new summer collection. I was actually inspired by a road trip I took last year through New Mexico.";
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'product announcement',
        primarySubject: 'summer collection',
        mainService: 'Ecommerce / apparel',
        specificWork: 'Launched a new summer collection.',
        people: [],
        organizations: [],
        meaningfulFacts: ['inspired by a road trip through New Mexico', 'personal inspiration behind the collection'],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: ['summer collection', 'new collection launch'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(promptsContaining(calls, transcript), 'full transcript must appear in prompt');
    assert.ok(
      promptsContaining(calls, 'road trip') || promptsContaining(calls, 'New Mexico'),
      'anecdote detail must appear in the prompt'
    );
  });
});

// ── Test E — Testimonial accuracy ─────────────────────────────────────────────

describe('Test E — Testimonial accuracy', () => {
  it('includes anti-fabrication rules in prompt and passes the original transcript', async () => {
    const transcript = "A customer told me the pool pump was quieter than expected and they were really happy with it.";
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'customer feedback',
        primarySubject: 'pool pump installation',
        mainService: 'Pool equipment',
        specificWork: 'Customer positive feedback on pool pump.',
        people: [],
        organizations: [],
        meaningfulFacts: ['pool pump quieter than expected', 'customer was happy'],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: ['pool pump', 'quiet pump'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(promptsContaining(calls, transcript), 'full transcript in prompt');
    // Prompt must instruct the model not to invent quotes/testimonials
    assert.ok(
      promptsContaining(calls, 'Do not invent facts, quotes, testimonials'),
      'prompt must include anti-fabrication instruction'
    );
  });
});

// ── Test F — Short transcript ─────────────────────────────────────────────────

describe('Test F — Short transcript', () => {
  it('does not impose a minimum word count for a brief update', async () => {
    const transcript = 'Quick update — office is closed Monday.';
    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'personal update',
        primarySubject: 'office closure',
        mainService: '',
        specificWork: 'Office closed on Monday.',
        people: [],
        organizations: [],
        meaningfulFacts: ['office closed Monday'],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: [],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    // Prompt must not force a rigid minimum word count
    assert.ok(
      !promptsContaining(calls, '100–200 words') && !promptsContaining(calls, '150–300 words'),
      'prompt should not impose rigid word counts'
    );
    // Prompt should allow content-length matching
    assert.ok(
      promptsContaining(calls, 'do not pad'),
      'prompt should instruct not to pad content'
    );
  });
});

// ── Test G — Long transcript ─────────────────────────────────────────────────

describe('Test G — Long transcript with multiple ideas', () => {
  it('passes all ideas to the generation prompt via the full transcript', async () => {
    const transcript = [
      'Just finished the Thompson kitchen renovation.',
      'We replaced all the cabinets with custom white shaker style.',
      'Maria on our team did an incredible job with the finish work — real attention to detail.',
      'The homeowners have two young kids so we had to work around their schedule.',
      'The tile backsplash is a handmade Talavera style that the owner found in Mexico.',
      'Really proud of how it turned out.',
    ].join(' ');

    const calls = installOpenAIMock({
      transcribedText: transcript,
      extractionResult: {
        location: null,
        contentIntent: 'project update',
        primarySubject: 'Thompson kitchen renovation',
        mainService: 'Kitchen renovation',
        specificWork: 'Completed a full kitchen renovation for the Thompson family.',
        people: ['Maria — finish work, recognized for attention to detail'],
        organizations: [],
        meaningfulFacts: [
          'custom white shaker cabinets',
          'Maria did exceptional finish work',
          'worked around homeowners schedule with two young kids',
          'Talavera tile backsplash sourced from Mexico',
          'homeowners found the tile themselves',
        ],
        explicitUrls: [],
        ctaHint: null,
        keyTerms: ['kitchen renovation', 'custom cabinets', 'Talavera tile'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '3')
      .field('classifications', JSON.stringify(['Before', 'After', 'General']))
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    // Full transcript must appear in prompt
    assert.ok(promptsContaining(calls, transcript), 'full transcript in prompt');
    // Key details from the brief must reach generation prompts
    assert.ok(promptsContaining(calls, 'Maria'), 'Maria must appear in prompt');
    assert.ok(promptsContaining(calls, 'Talavera'), 'Talavera tile detail must appear in prompt');
  });
});

// ── Test H — No website ───────────────────────────────────────────────────────

describe('Test H — No website provided', () => {
  it('buildCtaBlock instructs no-link CTA when no URL is available', () => {
    const block = _buildCtaBlock({
      extracted: { primarySubject: '', explicitUrls: [], organizations: [] },
      businessInquiryUrl: '',
      businessWebsite: '',
      businessName: 'Test Business',
    });

    assert.ok(
      block.includes('No URL is available') || block.includes('no-link CTA'),
      'CTA block should handle missing URL gracefully'
    );
    assert.ok(!block.includes('undefined'), 'CTA block must not contain undefined');
    assert.ok(!block.includes('null'), 'CTA block must not contain null');
  });

  it('returns a valid response without fabricating a URL', async () => {
    const calls = installOpenAIMock({
      transcribedText: 'Finished a landscaping project today.',
      extractionResult: {
        location: null, contentIntent: 'project update', primarySubject: '', mainService: 'Landscaping',
        specificWork: 'Completed landscaping.', people: [], organizations: [],
        meaningfulFacts: [], explicitUrls: [], ctaHint: null, keyTerms: ['landscaping'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(promptsContaining(calls, 'Never invent or hallucinate URLs'), 'no-URL rule in prompt');
  });
});

// ── Test I — Writing styles ───────────────────────────────────────────────────

describe('Test I — Writing styles', () => {
  const styles = [
    ['Professional',              'formal and authoritative'],
    ['Casual / Professional',     'friendly yet professional'],
    ['Friendly & Conversational', 'warm and conversational'],
    ['Straightforward',           'direct and concise'],
    ['Confident & Bold',          'confident and results-focused'],
    ['Storytelling',              'narrative-driven'],
    ['Playful & Lighthearted',    'upbeat and lighthearted'],
  ];

  for (const [style, expectedTone] of styles) {
    it(`maps "${style}" to expected tone descriptor`, () => {
      const tone = _writingToneFor(style);
      assert.ok(
        tone.toLowerCase().includes(expectedTone.split(' ')[0].toLowerCase()),
        `tone for "${style}" should contain "${expectedTone}" — got "${tone}"`
      );
    });
  }

  it('falls back to friendly yet professional for unknown style', () => {
    assert.strictEqual(_writingToneFor('Unknown Style'), 'friendly yet professional');
  });

  it('passes writing tone into the generation prompt', async () => {
    const calls = installOpenAIMock({
      transcribedText: 'Installed new flooring today.',
      extractionResult: {
        location: null, contentIntent: 'project update', primarySubject: '', mainService: 'Flooring',
        specificWork: 'Installed flooring.', people: [], organizations: [],
        meaningfulFacts: [], explicitUrls: [], ctaHint: null, keyTerms: ['flooring'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '0')
      .field('writingStyle', 'Storytelling')
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(
      promptsContaining(calls, 'narrative-driven'),
      'storytelling tone should appear in generation prompt'
    );
  });
});

// ── Test J — Before/After content ────────────────────────────────────────────

describe('Test J — Before/After photo handling', () => {
  it('allows transformation mention when both Before and After photos are present', async () => {
    const calls = installOpenAIMock({
      transcribedText: 'Completed a full bathroom remodel.',
      extractionResult: {
        location: null, contentIntent: 'project update', primarySubject: 'bathroom remodel',
        mainService: 'Remodeling', specificWork: 'Full bathroom remodel.',
        people: [], organizations: [], meaningfulFacts: [],
        explicitUrls: [], ctaHint: null, keyTerms: ['bathroom remodel'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '2')
      .field('classifications', JSON.stringify(['Before', 'After']))
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(
      promptsContaining(calls, 'Before and After photos are included'),
      'prompt should allow transformation reference when both photos present'
    );
  });

  it('forbids transformation mention when Before/After photos are absent', async () => {
    const calls = installOpenAIMock({
      transcribedText: 'Installed a new deck today.',
      extractionResult: {
        location: null, contentIntent: 'project update', primarySubject: 'deck installation',
        mainService: 'Decking', specificWork: 'Installed new deck.',
        people: [], organizations: [], meaningfulFacts: [],
        explicitUrls: [], ctaHint: null, keyTerms: ['deck installation'],
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .attach('audio', dummyAudioBuffer(), { filename: 'test.m4a', contentType: 'audio/m4a' })
      .field('photoCount', '1')
      .field('classifications', JSON.stringify(['General']))
      .field('platforms', JSON.stringify(['social']));

    assert.strictEqual(res.status, 200);
    assert.ok(
      promptsContaining(calls, 'Do NOT mention before/after'),
      'prompt should prohibit transformation reference when photos are absent'
    );
  });
});

// ── CTA unit tests ────────────────────────────────────────────────────────────

describe('buildCtaBlock unit tests', () => {
  it('uses inquiry URL when available (priority over website)', () => {
    const block = _buildCtaBlock({
      extracted: { primarySubject: '', explicitUrls: [], organizations: [] },
      businessInquiryUrl: 'example.com/contact',
      businessWebsite: 'example.com',
      businessName: 'Acme Co',
    });
    assert.ok(block.includes('example.com/contact'), 'inquiry URL should appear');
    assert.ok(block.includes('Publisher contact URL'), 'should be labelled as publisher contact');
  });

  it('falls back to website when no inquiry URL', () => {
    const block = _buildCtaBlock({
      extracted: { primarySubject: '', explicitUrls: [], organizations: [] },
      businessInquiryUrl: '',
      businessWebsite: 'mybiz.com',
      businessName: 'My Biz',
    });
    assert.ok(block.includes('mybiz.com'), 'website should appear as publisher URL');
  });

  it('does not force a CTA when no URL and no content URL', () => {
    const block = _buildCtaBlock({
      extracted: { primarySubject: '', explicitUrls: [], organizations: [] },
      businessInquiryUrl: '',
      businessWebsite: '',
      businessName: '',
    });
    assert.ok(block.includes('No URL is available'), 'should gracefully handle no URL');
  });
});
