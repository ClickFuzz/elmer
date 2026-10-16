'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  orderWithFeaturedFirst,
  parseIntArray,
  IG_MIN_AR,
  IG_MAX_AR,
} = require('../routes/media-utils');

// ── orderWithFeaturedFirst ────────────────────────────────────────────────────

describe('orderWithFeaturedFirst', () => {
  const files = ['a', 'b', 'c', 'd'];

  it('returns original order when featuredIndex is 0', () => {
    assert.deepEqual(orderWithFeaturedFirst(files, 0), files);
  });

  it('moves the featured item to front', () => {
    assert.deepEqual(orderWithFeaturedFirst(files, 2), ['c', 'a', 'b', 'd']);
  });

  it('handles last-item featured', () => {
    assert.deepEqual(orderWithFeaturedFirst(files, 3), ['d', 'a', 'b', 'c']);
  });

  it('returns original order when featuredIndex out of range', () => {
    assert.deepEqual(orderWithFeaturedFirst(files, 10), files);
    assert.deepEqual(orderWithFeaturedFirst(files, -1), files);
  });

  it('does not mutate the input array', () => {
    const original = ['x', 'y', 'z'];
    orderWithFeaturedFirst(original, 1);
    assert.deepEqual(original, ['x', 'y', 'z']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(orderWithFeaturedFirst([], 0), []);
  });
});

// ── parseIntArray ─────────────────────────────────────────────────────────────

describe('parseIntArray', () => {
  it('parses a JSON array of strings', () => {
    assert.deepEqual(parseIntArray('["General","Before","After"]'), ['General', 'Before', 'After']);
  });

  it('parses a JSON array of numbers', () => {
    assert.deepEqual(parseIntArray('[1,2,3]'), [1, 2, 3]);
  });

  it('returns [] for null/undefined', () => {
    assert.deepEqual(parseIntArray(null), []);
    assert.deepEqual(parseIntArray(undefined), []);
    assert.deepEqual(parseIntArray(''), []);
  });

  it('returns [] for invalid JSON', () => {
    assert.deepEqual(parseIntArray('not json'), []);
  });

  it('returns [] for a non-array JSON value', () => {
    assert.deepEqual(parseIntArray('"a string"'), []);
    assert.deepEqual(parseIntArray('42'), []);
  });

  it('accepts a native array directly', () => {
    assert.deepEqual(parseIntArray(['a', 'b']), ['a', 'b']);
  });
});

// ── IG aspect ratio constants ─────────────────────────────────────────────────

describe('Instagram aspect-ratio constants', () => {
  it('IG_MIN_AR is 4:5 portrait (0.8)', () => {
    assert.strictEqual(IG_MIN_AR, 0.8);
  });

  it('IG_MAX_AR is ~1.91 landscape', () => {
    assert.strictEqual(IG_MAX_AR, 1.91);
  });

  it('square 1:1 is within range', () => {
    const ar = 1;
    assert.ok(ar >= IG_MIN_AR && ar <= IG_MAX_AR);
  });

  it('9:16 portrait (0.5625) is below range', () => {
    const ar = 9 / 16;
    assert.ok(ar < IG_MIN_AR);
  });

  it('panoramic 2.5:1 is above range', () => {
    const ar = 2.5;
    assert.ok(ar > IG_MAX_AR);
  });
});
