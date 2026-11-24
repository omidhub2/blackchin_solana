import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultTransitKeyProvider } from '../src/infrastructure/security/vault-transit-key-provider.js';
import { createEnvelopeCrypto } from '../src/infrastructure/security/envelope-crypto.js';

const enabled = Boolean(process.env.VAULT_ADDR && process.env.VAULT_SIGNER_TOKEN);

test('live Vault Transit wraps DEKs and authenticates BLACKCHIN envelopes', { skip: !enabled }, async () => {
  const provider = createVaultTransitKeyProvider();
  const envelopeCrypto = createEnvelopeCrypto(provider);
  const aad = 'blackchin:tenant:17:hd-wallet:902:network:devnet:purpose:mnemonic:v1';
  const phrase = Buffer.from('disposable-devnet-only mnemonic test material');

  const envelope = await envelopeCrypto.encrypt(phrase, { aad });
  assert.match(envelope.wrappedKey, /^vault:v[1-9][0-9]*:/);
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.ok(!JSON.stringify(envelope).includes(phrase.toString('utf8')));

  const plaintext = await envelopeCrypto.decrypt(envelope, { aad });
  assert.deepEqual(plaintext, phrase);
  plaintext.fill(0);

  await assert.rejects(
    () => envelopeCrypto.decrypt(envelope, { aad: 'blackchin:tenant:18:hd-wallet:902:network:devnet:purpose:mnemonic:v1' }),
    /authentication failed/
  );
});
