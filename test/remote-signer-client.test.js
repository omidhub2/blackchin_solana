import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRemoteSignerClient } from '../src/infrastructure/security/remote-signer-client.js';

const MESSAGE = Buffer.from('canonical-solana-message');
const MESSAGE_B64 = MESSAGE.toString('base64');
const HASH = createHash('sha256').update(MESSAGE).digest('hex');
const PUBLIC_KEY = '11111111111111111111111111111111';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const BASE = {
  tenantId: '42',
  hdWalletId: '7',
  accountIndex: 2,
  publicKey: PUBLIC_KEY,
  network: 'devnet',
  message: MESSAGE_B64,
  authorization: 'a'.repeat(64)
};
const uuid = '11111111-1111-4111-8111-111111111111';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    async json() { return body; }
  };
}

test('remote signer sends only public transaction context and validates response binding', async () => {
  let captured;
  const client = createRemoteSignerClient({
    endpoint: 'https://signer.internal.example',
    bearerToken: 't'.repeat(48),
    requestId: () => uuid,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options, body: JSON.parse(options.body) };
      return response(200, {
        requestId: uuid,
        publicKey: PUBLIC_KEY,
        messageSha256: HASH,
        signature: SIGNATURE
      });
    }
  });

  const result = await client.signMessage(BASE);
  assert.equal(captured.url, 'https://signer.internal.example/v1/sign-message');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.authorization, `Bearer ${'t'.repeat(48)}`);
  assert.equal(captured.body.tenantId, '42');
  assert.equal(captured.body.hdWalletId, '7');
  assert.equal(captured.body.derivationPath, "m/44'/501'/2'/0'");
  assert.equal(captured.body.messageSha256, HASH);
  assert.equal(result.signature.length, 64);
  assert.equal(result.messageSha256, HASH);
  assert.equal('mnemonic' in captured.body, false);
  assert.equal('privateKey' in captured.body, false);
  assert.equal('secretKey' in captured.body, false);
});

test('remote signer rejects non-HTTPS endpoints and weak transport credentials', () => {
  assert.throws(() => createRemoteSignerClient({
    endpoint: 'http://signer.internal',
    bearerToken: 't'.repeat(48)
  }), /HTTPS/);
  assert.throws(() => createRemoteSignerClient({
    endpoint: 'https://signer.internal',
    bearerToken: 'short'
  }), /at least 32/);
});

test('remote signer validates derivation identity, network, capability and message size before I/O', async () => {
  let calls = 0;
  const client = createRemoteSignerClient({
    endpoint: 'https://signer.internal',
    bearerToken: 't'.repeat(48),
    fetchImpl: async () => { calls += 1; return response(200, {}); }
  });

  await assert.rejects(() => client.signMessage({ ...BASE, tenantId: '0' }), /tenantId/);
  await assert.rejects(() => client.signMessage({ ...BASE, accountIndex: -1 }), /accountIndex/);
  await assert.rejects(() => client.signMessage({ ...BASE, network: 'localnet' }), /network/);
  await assert.rejects(() => client.signMessage({ ...BASE, authorization: '' }), /authorization/);
  await assert.rejects(() => client.signMessage({ ...BASE, message: Buffer.alloc(1233).toString('base64') }), /message/);
  assert.equal(calls, 0);
});

test('remote signer fails closed on transport errors and never retries', async () => {
  let calls = 0;
  const client = createRemoteSignerClient({
    endpoint: 'https://signer.internal',
    bearerToken: 't'.repeat(48),
    fetchImpl: async () => { calls += 1; throw new Error('socket reset'); }
  });

  await assert.rejects(
    () => client.signMessage(BASE),
    (error) => error.code === 'REMOTE_SIGNER_UNAVAILABLE' && !error.message.includes('socket reset')
  );
  assert.equal(calls, 1);
});

test('remote signer rejects mismatched response and invalid signature length', async () => {
  const makeClient = (body) => createRemoteSignerClient({
    endpoint: 'https://signer.internal',
    bearerToken: 't'.repeat(48),
    requestId: () => uuid,
    fetchImpl: async () => response(200, body)
  });

  await assert.rejects(
    () => makeClient({ requestId: uuid, publicKey: PUBLIC_KEY, messageSha256: '0'.repeat(64), signature: SIGNATURE }).signMessage(BASE),
    (error) => error.code === 'REMOTE_SIGNER_RESPONSE_MISMATCH'
  );
  await assert.rejects(
    () => makeClient({ requestId: uuid, publicKey: PUBLIC_KEY, messageSha256: HASH, signature: Buffer.alloc(63).toString('base64') }).signMessage(BASE),
    (error) => error.code === 'REMOTE_SIGNER_UNAVAILABLE'
  );
});

test('remote signer treats authorization failure as service unavailable without leaking body', async () => {
  const client = createRemoteSignerClient({
    endpoint: 'https://signer.internal',
    bearerToken: 't'.repeat(48),
    fetchImpl: async () => response(403, { error: 'secret internal detail' })
  });
  await assert.rejects(
    () => client.signMessage(BASE),
    (error) => error.code === 'REMOTE_SIGNER_AUTH_FAILED' && !error.message.includes('secret internal detail')
  );
});
