import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';

import {
  deriveEd25519Seed,
  deriveAccountPath,
  deriveSolanaAccount,
  deriveSolanaPublicKey,
  generateHdMnemonic,
  mnemonicToHdSeed,
  normalizeMnemonic,
  validateHdMnemonic,
  assertSupportedDerivationPath,
  MAX_ACCOUNT_INDEX
} from '../src/blockchain/solana/hd/derivation.js';
import {
  deriveSlip10ChildKey,
  deriveSlip10MasterKey,
  deriveSlip10Path,
  parseHardenedPath
} from '../src/blockchain/solana/hd/slip10-ed25519.js';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon art';

test('generates a valid 24-word BIP39 mnemonic', () => {
  const mnemonic = generateHdMnemonic();

  assert.equal(mnemonic.split(' ').length, 24);
  assert.equal(validateHdMnemonic(mnemonic), true);
});

test('generates a distinct mnemonic on every call', () => {
  assert.notEqual(generateHdMnemonic(), generateHdMnemonic());
});

test('rejects invalid entropy sizes for mnemonic generation', () => {
  for (const bits of [0, 100, 129, 300, 256.5]) {
    assert.throws(() => generateHdMnemonic(bits), /Mnemonic entropy/);
  }
});

test('rejects mnemonics with a bad checksum or unsupported words', () => {
  const words = VECTOR_MNEMONIC.split(' ');
  const badChecksum = [...words.slice(0, 23), 'abandon'].join(' ');

  assert.equal(validateHdMnemonic(badChecksum), false);
  assert.equal(validateHdMnemonic('hello world'), false);
  assert.equal(validateHdMnemonic(''), false);
  assert.equal(validateHdMnemonic(42), false);
  assert.throws(() => mnemonicToHdSeed(badChecksum), /invalid/i);
});

test('normalizes mnemonic whitespace and case', () => {
  assert.equal(normalizeMnemonic('  ABANDON\tabandon \n'), 'abandon abandon');
});

test('BIP39 seed derivation matches the standard PBKDF2 procedure', () => {
  const expected = crypto.pbkdf2Sync(
    VECTOR_MNEMONIC.normalize('NFKD'),
    'mnemonic'.normalize('NFKD'),
    2048,
    64,
    'sha512'
  );

  assert.deepEqual(mnemonicToHdSeed(VECTOR_MNEMONIC), expected);
  assert.equal(mnemonicToHdSeed(VECTOR_MNEMONIC).length, 64);
});

test('BIP39 passphrase changes the derived seed', () => {
  const plain = mnemonicToHdSeed(VECTOR_MNEMONIC);
  const withPassphrase = mnemonicToHdSeed(VECTOR_MNEMONIC, 'TREZOR');

  assert.notDeepEqual(plain, withPassphrase);
});

test('SLIP-0010 Ed25519 matches the official test vector 1', () => {
  // Vector 1 from SLIP-0010 (seed 000102...0f), hardened-only path.
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const master = deriveSlip10MasterKey(seed);

  const chainCodes = [
    '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c'
  ];

  const privateKeys = [
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9'
  ];

  assert.equal(master.chainCode.toString('hex'), chainCodes[0]);
  assert.equal(master.key.toString('hex'), privateKeys[0]);

  const m0h = deriveSlip10ChildKey(master, 0);
  assert.equal(m0h.chainCode.toString('hex'), chainCodes[1]);
  assert.equal(m0h.key.toString('hex'), privateKeys[1]);

  const m0h1h = deriveSlip10ChildKey(m0h, 1);
  assert.equal(m0h1h.chainCode.toString('hex'), chainCodes[2]);
  assert.equal(m0h1h.key.toString('hex'), privateKeys[2]);

  const m0h1h2h = deriveSlip10ChildKey(m0h1h, 2);
  assert.equal(m0h1h2h.chainCode.toString('hex'), chainCodes[3]);
  assert.equal(m0h1h2h.key.toString('hex'), privateKeys[3]);

  const m0h1h2h2h = deriveSlip10Path(master, "m/0'/1'/2'/2'");
  assert.equal(
    m0h1h2h2h.chainCode.toString('hex'),
    '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc'
  );
});

test('SLIP-0010 derivation rejects invalid seeds and indexes', () => {
  assert.throws(() => deriveSlip10MasterKey(Buffer.alloc(8)), /seed must be/);
  assert.throws(() => deriveSlip10MasterKey(Buffer.alloc(65)), /seed must be/);

  const master = deriveSlip10MasterKey(Buffer.alloc(16, 1));

  for (const index of [-1, 1.5, MAX_ACCOUNT_INDEX + 1, '0']) {
    assert.throws(() => deriveSlip10ChildKey(master, index), /Derivation index/);
  }
});

test('parses hardened paths and rejects invalid ones', () => {
  assert.deepEqual(parseHardenedPath("m/44'/501'/0'/0'"), [44, 501, 0, 0]);

  for (const path of ['m/44/501', "m/44'/501", "44'/501'", '', "m/44'h/501'", "m/-1'", null]) {
    assert.throws(() => parseHardenedPath(path), /Derivation path/);
  }
});

test('account path template is stable', () => {
  assert.equal(deriveAccountPath(0), "m/44'/501'/0'/0'");
  assert.equal(deriveAccountPath(7), "m/44'/501'/7'/0'");
  assert.throws(() => deriveAccountPath(-1), /Account index/);
  assert.throws(() => deriveAccountPath(MAX_ACCOUNT_INDEX + 1), /Account index/);

  assert.equal(assertSupportedDerivationPath("m/44'/501'/3'/0'", 3), "m/44'/501'/3'/0'");
  assert.throws(
    () => assertSupportedDerivationPath("m/44'/501'/4'/0'", 3),
    /does not match the supported scheme/
  );
  assert.throws(
    () => assertSupportedDerivationPath("m/44'/501'/3'/1'", 3),
    /does not match the supported scheme/
  );
});

test('derivation is deterministic and produces valid Solana keypairs', () => {
  const first = deriveSolanaAccount(VECTOR_MNEMONIC, 0);
  const second = deriveSolanaAccount(VECTOR_MNEMONIC, 0);
  const other = deriveSolanaAccount(VECTOR_MNEMONIC, 1);

  assert.equal(first.publicKey, second.publicKey);
  assert.notEqual(first.publicKey, other.publicKey);
  assert.equal(first.derivationPath, "m/44'/501'/0'/0'");
  assert.equal(other.derivationPath, "m/44'/501'/1'/0'");
  assert.equal(first.secretKey.length, 64);
  assert.equal(first.keypair.publicKey.toBase58(), first.publicKey);
  assert.equal(
    Keypair.fromSecretKey(first.secretKey).publicKey.toBase58(),
    first.publicKey
  );

  const seed = deriveEd25519Seed(mnemonicToHdSeed(VECTOR_MNEMONIC), 5);
  assert.equal(seed.length, 32);
});

test('derived addresses are stable across releases (regression vector)', () => {
  // Computed with this repository's scheme and covered by recovery tests.
  // If this assertion changes, existing wallets would become unreachable.
  const expected = [
    { index: 0, publicKey: '3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx' },
    { index: 1, publicKey: '5frqxtii9LeGq2bz3dSNokvZcEooF483MzeU24JrhcTA' },
    { index: 2, publicKey: '3SuKj3MZU9dMZ9oR1R7afttihZFkWpfUmduuv9rmfMa1' }
  ];

  for (const item of expected) {
    assert.equal(deriveSolanaAccount(VECTOR_MNEMONIC, item.index).publicKey, item.publicKey);
    assert.equal(
      deriveSolanaPublicKey(VECTOR_MNEMONIC, item.index).publicKey,
      item.publicKey
    );
  }
});

test('a BIP39 passphrase produces different child addresses', () => {
  const without = deriveSolanaAccount(VECTOR_MNEMONIC, 0);
  const withPassphrase = deriveSolanaAccount(VECTOR_MNEMONIC, 0, { passphrase: 'TREZOR' });

  assert.notEqual(without.publicKey, withPassphrase.publicKey);
});

test('derivation rejects out-of-range account indexes', () => {
  for (const index of [-1, 1.5, MAX_ACCOUNT_INDEX + 1, NaN, '0', undefined]) {
    assert.throws(() => deriveSolanaAccount(VECTOR_MNEMONIC, index), /Account index/);
  }
});
