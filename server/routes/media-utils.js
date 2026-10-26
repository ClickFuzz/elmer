'use strict';

/* global Buffer */
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const IG_MIN_AR  = 0.8;   // 4:5 portrait
const IG_MAX_AR  = 1.91;  // ~1.91:1 landscape
const IG_MAX_DIM = 1440;
const DARK_BG    = { r: 20, g: 20, b: 20, alpha: 1 };

// ── Lazy sharp loader (avoids crashing tests that mock it away) ────────────────

let _sharp = null;
function getSharp() {
  if (!_sharp) _sharp = require('sharp');
  return _sharp;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the post-EXIF-rotation effective {width, height} of a file.
async function getEffectiveDimensions(filePath) {
  const sharp = getSharp();
  const meta  = await sharp(filePath).metadata();
  const rawW  = meta.width  ?? 0;
  const rawH  = meta.height ?? 0;
  const ori   = meta.orientation ?? 1;
  const transposed = ori >= 5 && ori <= 8;
  return {
    width:  transposed ? rawH : rawW,
    height: transposed ? rawW : rawH,
  };
}

// Prepares a single photo for Instagram Feed.
// Ensures: JPEG, EXIF-corrected, within IG_MAX_DIM, aspect ratio in [IG_MIN_AR, IG_MAX_AR].
// Returns path to the processed file (may be inputPath itself if already compliant).
async function prepareForInstagram(inputPath) {
  const sharp = getSharp();
  const { width: w, height: h } = await getEffectiveDimensions(inputPath);
  const ar  = w / h;
  const out = inputPath + '_ig.jpg';

  if (ar >= IG_MIN_AR && ar <= IG_MAX_AR) {
    // Aspect ratio valid — rotate + cap resolution + JPEG
    await sharp(inputPath)
      .rotate()
      .resize({ width: IG_MAX_DIM, height: IG_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toFile(out);
    return out;
  }

  if (ar < IG_MIN_AR) {
    // Too tall (e.g., 9:16) — pad left/right to reach 4:5
    const scaledH = Math.min(h, IG_MAX_DIM);
    const targetW = Math.round(scaledH * IG_MIN_AR);
    await sharp(inputPath)
      .rotate()
      .resize({ width: targetW, height: scaledH, fit: 'contain', background: DARK_BG })
      .jpeg({ quality: 92 })
      .toFile(out);
    return out;
  }

  // Too wide (panoramic) — pad top/bottom to reach 1.91:1
  const scaledW = Math.min(w, IG_MAX_DIM);
  const targetH = Math.round(scaledW / IG_MAX_AR);
  await sharp(inputPath)
    .rotate()
    .resize({ width: scaledW, height: targetH, fit: 'contain', background: DARK_BG })
    .jpeg({ quality: 92 })
    .toFile(out);
  return out;
}

// Normalises all carousel images to the same aspect ratio (the first image's
// effective ratio, clamped to [IG_MIN_AR, IG_MAX_AR]).  Returns a new array
// of prepared file paths; caller is responsible for cleanup.
async function prepareCarouselForInstagram(inputPaths) {
  if (inputPaths.length === 0) return [];

  const sharp = getSharp();

  // Determine target ratio from first image
  const { width: fw, height: fh } = await getEffectiveDimensions(inputPaths[0]);
  const rawAr    = fw / fh;
  const targetAr = Math.max(IG_MIN_AR, Math.min(IG_MAX_AR, rawAr));

  // Target dimensions: fit within IG_MAX_DIM
  let targetW, targetH;
  if (targetAr >= 1) {
    targetW = IG_MAX_DIM;
    targetH = Math.round(IG_MAX_DIM / targetAr);
  } else {
    targetH = IG_MAX_DIM;
    targetW = Math.round(IG_MAX_DIM * targetAr);
  }

  const results = [];
  for (const inputPath of inputPaths) {
    const out = inputPath + '_carousel.jpg';
    await sharp(inputPath)
      .rotate()
      .resize({ width: targetW, height: targetH, fit: 'contain', background: DARK_BG })
      .jpeg({ quality: 92 })
      .toFile(out);
    results.push(out);
  }
  return results;
}

// Generates a 1080×1080 side-by-side before/after composite.
// Both halves use `contain` to preserve the full image — padding fills gaps.
// Returns path to the composite JPEG.
async function generateBeforeAfterComposite(beforePath, afterPath, outputDir) {
  const sharp   = getSharp();
  const SIZE    = 1080;
  const HALF_W  = 537;   // slightly less than half, gives 3-px gap at centre
  const GAP     = SIZE - HALF_W * 2;  // = 6px (3 each side)
  const LABEL_H = 52;

  const [beforeBuf, afterBuf] = await Promise.all([
    sharp(beforePath)
      .rotate()
      .resize({ width: HALF_W, height: SIZE, fit: 'contain', background: DARK_BG })
      .jpeg({ quality: 90 })
      .toBuffer(),
    sharp(afterPath)
      .rotate()
      .resize({ width: HALF_W, height: SIZE, fit: 'contain', background: DARK_BG })
      .jpeg({ quality: 90 })
      .toBuffer(),
  ]);

  const makeLabelSvg = (text) =>
    Buffer.from(
      `<svg width="${HALF_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${HALF_W}" height="${LABEL_H}" fill="rgba(0,0,0,0.62)"/>` +
      `<text x="${HALF_W / 2}" y="${LABEL_H / 2 + 1}" ` +
      `font-family="system-ui,Arial,sans-serif" font-size="20" font-weight="700" ` +
      `fill="white" text-anchor="middle" dominant-baseline="middle">${text}</text>` +
      `</svg>`
    );

  const filename = `composite_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const outPath  = path.join(outputDir, filename);

  await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: { r: 12, g: 12, b: 12 } },
  })
    .composite([
      { input: beforeBuf,                      top: 0,           left: 0 },
      { input: afterBuf,                       top: 0,           left: HALF_W + GAP },
      { input: makeLabelSvg('BEFORE'),         top: SIZE - LABEL_H, left: 0 },
      { input: makeLabelSvg('AFTER'),          top: SIZE - LABEL_H, left: HALF_W + GAP },
    ])
    .jpeg({ quality: 92 })
    .toFile(outPath);

  return outPath;
}

// Orders a photo-file array so the featured index comes first.
// Safe when featuredIndex is out of range (falls back to original order).
function orderWithFeaturedFirst(files, featuredIndex) {
  if (!Number.isInteger(featuredIndex) || featuredIndex <= 0 || featuredIndex >= files.length) {
    return files;
  }
  const reordered = [...files];
  const [feat]    = reordered.splice(featuredIndex, 1);
  reordered.unshift(feat);
  return reordered;
}

// Safe JSON parse for arrays, returns [] on failure.
function parseIntArray(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Prepares a single photo for Google Business Profile.
// GBP requires: JPEG, EXIF-corrected, max 5 MB, min 250×250 px.
// Caps longest edge at 2048 px and encodes at 85% JPEG quality.
async function prepareForGbp(inputPath) {
  const sharp = getSharp();
  const out = inputPath + '_gbp.jpg';
  try {
    await sharp(inputPath)
      .rotate()                             // EXIF auto-rotation
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(out);
    return out;
  } catch (err) {
    console.warn('[media-utils] prepareForGbp failed, using original:', err.message);
    return inputPath;
  }
}

module.exports = {
  getEffectiveDimensions,
  prepareForInstagram,
  prepareCarouselForInstagram,
  prepareForGbp,
  generateBeforeAfterComposite,
  orderWithFeaturedFirst,
  parseIntArray,
  IG_MIN_AR,
  IG_MAX_AR,
};
