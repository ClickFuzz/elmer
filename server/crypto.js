'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES   = 12;   // 96-bit nonce — optimal for GCM
const TAG_BYTES  = 16;   // 128-bit authentication tag

function resolveKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string.
 * Returns a hex string encoding: IV (12 bytes) + GCM tag (16 bytes) + ciphertext.
 */
function encrypt(plaintext) {
  const key = resolveKey();
  const iv  = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

/**
 * Decrypts a hex string produced by encrypt().
 * Throws if the key is wrong or the ciphertext has been tampered with.
 */
function decrypt(hex) {
  const key      = resolveKey();
  const buf      = Buffer.from(hex, 'hex');
  const iv       = buf.subarray(0, IV_BYTES);
  const tag      = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
