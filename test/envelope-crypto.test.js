import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelopeCrypto } from '../src/infrastructure/security/envelope-crypto.js';

function fakeProvider() {
  const keys = new Map();
  const kek = Buffer.alloc(32, 0x5a);
  return {
    currentVersion: 1,
    async wrapKey(dek) {
      const id = `vault:v1:${(keys.size + 1).toString(16)}`;
      // Test-only fake wrapping. Production uses Vault Transit and never this map.
      const mask = Buffer.from(kek);
      const wrapped = Buffer.from(dek.map((byte, index) => byte ^ mask[index]));
      keys.set(id, wrapped);
      return { wrappedKey: id, keyVersion: 1 };
    },
    async unwrapKey(id) {
      const wrapped = keys.get(id);
      if (!wrapped) throw new Error('unknown wrapped key');
      return Buffer.from(wrapped.map((byte, index) => byte ^ kek[index]));
    }
  };
}

test('envelope encrypt/decrypt round trip uses wrapped per-envelope DEK', async () => {
  const crypto = createEnvelopeCrypto(fakeProvider());
  const sealed = await crypto.encrypt('devnet-only test mnemonic', {
    aad: 'hd_wallets:77:tenant:12:network:devnet:mnemonic:v1'
  });
  assert.equal(sealed.version, 1);
  assert.equal(sealed.algorithm, 'aes-256-gcm');
  assert.ok(sealed.wrappedKey.startsWith('vault:v1:'));
  assert.equal('dek' in sealed, false);
  const opened = await crypto.decrypt(sealed, {
    aad: 'hd_wallets:77:tenant:12:network:devnet:mnemonic:v1'
  });
  assert.equal(opened.toString('utf8'), 'devnet-only test mnemonic');
  opened.fill(0);
});

test('envelope rejects wrong AAD and ciphertext/tag tampering', async () => {
  const crypto = createEnvelopeCrypto(fakeProvider());
  const sealed = await crypto.encrypt('secret', { aad: 'wallet:1:mnemonic:v1' });
  await assert.rejects(
    () => crypto.decrypt(sealed, { aad: 'wallet:2:mnemonic:v1' }),
    /authentication failed/
  );
  await assert.rejects(
    () => crypto.decrypt({ ...sealed, authTag: '00'.repeat(16) }, { aad: 'wallet:1:mnemonic:v1' }),
    /authentication failed/
  );
});

test('envelope refuses malformed metadata and oversized plaintext', async () => {
  const crypto = createEnvelopeCrypto(fakeProvider());
  await assert.rejects(() => crypto.encrypt('x', { aad: '' }), /AAD/);
  await assert.rejects(
    () => crypto.encrypt(Buffer.alloc(65 * 1024), { aad: 'test:v1' }),
    /size/
  );
  await assert.rejects(
    () => crypto.decrypt({ version: 99 }, { aad: 'test:v1' }),
    /Invalid or unsupported/
  );
});
