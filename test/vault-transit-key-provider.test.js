import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultTransitKeyProvider } from '../src/infrastructure/security/vault-transit-key-provider.js';

function fakeResponse(ok, data, status = ok ? 200 : 403) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    async json() { return data; }
  };
}

test('Vault Transit wraps and unwraps exactly a 32-byte DEK', async () => {
  const dek = Buffer.alloc(32, 0x42);
  let captured;
  const provider = createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'local-test-vault-token-123456',
    keyName: 'blackchin-envelope',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options, body: JSON.parse(options.body) };
      if (String(url).endsWith('/encrypt/blackchin-envelope')) {
        return fakeResponse(true, { data: { ciphertext: 'vault:v3:YWJjZA==' } });
      }
      return fakeResponse(true, { data: { plaintext: dek.toString('base64') } });
    }
  });

  const wrapped = await provider.wrapKey(dek);
  assert.equal(wrapped.wrappedKey, 'vault:v3:YWJjZA==');
  assert.equal(wrapped.keyVersion, 3);
  assert.equal(captured.options.headers['x-vault-token'], 'local-test-vault-token-123456');
  assert.equal(captured.body.plaintext, dek.toString('base64'));

  const unwrapped = await provider.unwrapKey(wrapped.wrappedKey);
  assert.deepEqual(unwrapped, dek);
  unwrapped.fill(0);
});

test('Vault Transit rejects remote HTTP, malformed ciphertext and weak configuration', () => {
  assert.throws(() => createVaultTransitKeyProvider({
    address: 'http://vault.example.com',
    token: 'local-test-vault-token-123456'
  }), /HTTPS/);
  assert.throws(() => createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'short'
  }), /required/);
  assert.throws(() => createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'local-test-vault-token-123456',
    keyName: '../bad'
  }), /key name/);
});

test('Vault Transit never exposes Vault error response bodies', async () => {
  const provider = createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'local-test-vault-token-123456',
    fetchImpl: async () => fakeResponse(false, { errors: ['sensitive vault diagnostic'] }, 403)
  });
  await assert.rejects(
    () => provider.wrapKey(Buffer.alloc(32, 1)),
    (error) => error.code === 'VAULT_PERMISSION_DENIED' &&
      !error.message.includes('sensitive vault diagnostic')
  );
});

test('Vault Transit rejects malformed or wrong-sized plaintext DEKs', async () => {
  const malformed = createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'local-test-vault-token-123456',
    fetchImpl: async () => fakeResponse(true, { data: { plaintext: Buffer.alloc(16, 1).toString('base64') } })
  });
  await assert.rejects(() => malformed.unwrapKey('vault:v1:YWJjZA=='), /failed/);

  const provider = createVaultTransitKeyProvider({
    address: 'http://127.0.0.1:8200',
    token: 'local-test-vault-token-123456',
    fetchImpl: async () => fakeResponse(true, { data: { ciphertext: 'bad' } })
  });
  await assert.rejects(() => provider.wrapKey(Buffer.alloc(32)), /failed/);
});
