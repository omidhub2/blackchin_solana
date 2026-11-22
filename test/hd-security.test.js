import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCipher,
  createEnvKeyProvider,
  CURRENT_KEY_VERSION
} from '../src/infrastructure/security/hd-envelope.js';
import {
  createPurposeTokenCodec,
  derivePurposeKey
} from '../src/infrastructure/security/purpose-token.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const PLAINTEXT =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const provider = (env) => createEnvKeyProvider(env);

test('key provider rejects missing or malformed keys', () => {
  assert.throws(() => provider({}), /ENCRYPTION_KEY must be configured/);
  assert.throws(() => provider({ ENCRYPTION_KEY: 'abc' }), /ENCRYPTION_KEY/);
  assert.throws(() => provider({ ENCRYPTION_KEY: 'z'.repeat(64) }), /ENCRYPTION_KEY/);
});

test('key provider selects the highest version for new writes', () => {
  const keys = provider({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_V3: KEY_B });

  assert.equal(keys.currentVersion, 3);
  assert.equal(keys.keyFor(1).toString('hex'), KEY_A);
  assert.equal(keys.keyFor(3).toString('hex'), KEY_B);
  assert.throws(() => keys.keyFor(2), /No encryption key configured for version 2/);
});

test('encrypt/decrypt round-trip with AAD binding', () => {
  const cipher = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));
  const sealed = cipher.encrypt(PLAINTEXT, { aad: 'hd_wallets:1:mnemonic:v1' });

  assert.equal(sealed.keyVersion, CURRENT_KEY_VERSION);
  assert.match(sealed.ciphertext, /^[a-f0-9]+$/);
  assert.equal(sealed.iv.length, 24);
  assert.equal(sealed.authTag.length, 32);
  assert.notEqual(sealed.ciphertext, Buffer.from(PLAINTEXT).toString('hex'));

  assert.equal(
    cipher.decrypt(sealed.ciphertext, sealed.iv, sealed.authTag, {
      aad: 'hd_wallets:1:mnemonic:v1'
    }),
    PLAINTEXT
  );
});

test('ciphertext is bound to its AAD record id', () => {
  const cipher = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));
  const sealed = cipher.encrypt(PLAINTEXT, { aad: 'hd_wallets:1:mnemonic:v1' });

  assert.throws(
    () =>
      cipher.decrypt(sealed.ciphertext, sealed.iv, sealed.authTag, {
        aad: 'hd_wallets:2:mnemonic:v1'
      }),
    /Decryption failed/
  );
});

test('every encryption uses a fresh IV', () => {
  const cipher = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));
  const first = cipher.encrypt(PLAINTEXT);
  const second = cipher.encrypt(PLAINTEXT);

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('decryption fails with the wrong key or tampered tag', () => {
  const cipherA = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));
  const cipherB = createCipher(provider({ ENCRYPTION_KEY: KEY_B }));
  const sealed = cipherA.encrypt(PLAINTEXT);

  assert.throws(() => cipherB.decrypt(sealed.ciphertext, sealed.iv, sealed.authTag), /Decryption failed/);
  assert.throws(() => cipherA.decrypt(sealed.ciphertext, sealed.iv, '00'.repeat(16)), /Decryption failed/);
});

test('malformed stored fields are rejected before any crypto', () => {
  const cipher = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));

  assert.throws(() => cipher.decrypt('not-hex', '0'.repeat(24), '0'.repeat(32)), /encrypted data format/);
  assert.throws(() => cipher.decrypt('aabb', 'short', '0'.repeat(32)), /encryption IV/);
  assert.throws(() => cipher.decrypt('aabb', '0'.repeat(24), 'bad'), /authentication tag/);
  assert.throws(() => cipher.encrypt(''), /non-empty string/);
});

test('key versioning decrypts old records after rotation', () => {
  const v2Only = createCipher(provider({ ENCRYPTION_KEY_V2: KEY_B }));
  const sealedV2 = v2Only.encrypt(PLAINTEXT);
  assert.equal(sealedV2.keyVersion, 2);

  const rotated = createCipher(provider({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_V2: KEY_B }));
  assert.equal(
    rotated.decrypt(sealedV2.ciphertext, sealedV2.iv, sealedV2.authTag, { keyVersion: 2 }),
    PLAINTEXT
  );

  const legacy = createCipher(provider({ ENCRYPTION_KEY: KEY_A }));
  const sealedV1 = legacy.encrypt(PLAINTEXT);
  assert.equal(sealedV1.keyVersion, 1);
  assert.equal(
    rotated.decrypt(sealedV1.ciphertext, sealedV1.iv, sealedV1.authTag, { keyVersion: 1 }),
    PLAINTEXT
  );
  assert.throws(
    () => rotated.decrypt(sealedV1.ciphertext, sealedV1.iv, sealedV1.authTag, { keyVersion: 2 }),
    /Decryption failed/
  );
});

test('recovery tokens are purpose-bound and tamper-evident', () => {
  const keyProvider = provider({ ENCRYPTION_KEY: KEY_A });
  const tokens = createPurposeTokenCodec(keyProvider);
  const token = tokens.seal('recovery-phrase', PLAINTEXT);

  assert.equal(tokens.open('recovery-phrase', token), PLAINTEXT);
  assert.throws(() => tokens.open('root-mnemonic', token), /invalid, expired, or already used/i);
  assert.throws(() => tokens.open('recovery-phrase', 'not-a-token'), /invalid/i);
  assert.throws(() => derivePurposeKey(keyProvider, 'unsupported'), /Unsupported encryption purpose/);

  const tampered = Buffer.from(token, 'base64url');
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(
    () => tokens.open('recovery-phrase', tampered.toString('base64url')),
    /invalid/i
  );

  const otherKeyProvider = provider({ ENCRYPTION_KEY: KEY_B });
  assert.throws(
    () => createPurposeTokenCodec(otherKeyProvider).open('recovery-phrase', token),
    /invalid/i
  );
});

test('a recovery token cannot be used as stored-record ciphertext', () => {
  const keyProvider = provider({ ENCRYPTION_KEY: KEY_A });
  const tokens = createPurposeTokenCodec(keyProvider);
  const cipher = createCipher(keyProvider);
  const token = tokens.seal('recovery-phrase', PLAINTEXT);

  // Different key derivation + AEAD AAD => record decryption rejects the token.
  assert.throws(
    () => {
      const raw = Buffer.from(token, 'base64url');
      cipher.decrypt(
        raw.subarray(28).toString('hex'),
        raw.subarray(0, 12).toString('hex'),
        raw.subarray(12, 28).toString('hex'),
        { aad: 'hd_wallets:1:mnemonic:v1' }
      );
    },
    /Decryption failed/
  );
});
