import pg from 'pg';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// ============================================================
// Environment configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '../.env')
});

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY;
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SOLANA_SECRET_KEY_LENGTH = 64;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const SOLANA_COMMITMENTS = new Set([
  'processed',
  'confirmed',
  'finalized'
]);

// ============================================================
// Environment validation
// ============================================================

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured');
}

if (
  typeof ENCRYPTION_KEY_HEX !== 'string' ||
  !/^[a-fA-F0-9]{64}$/.test(ENCRYPTION_KEY_HEX)
) {
  throw new Error(
    'ENCRYPTION_KEY must contain exactly 64 hexadecimal characters'
  );
}

if (!['devnet', 'testnet', 'mainnet-beta'].includes(SOLANA_NETWORK)) {
  throw new Error('SOLANA_NETWORK must be devnet, testnet or mainnet-beta');
}

function validateDatabaseUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('DATABASE_URL is not a valid URL', { cause: error });
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// protocol');
  }

  if (!url.hostname || !url.username || !url.pathname || url.pathname === '/') {
    throw new Error('DATABASE_URL must include host, username and database name');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(hostname);

  if (
    !isLocalhost &&
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(
      'Remote PostgreSQL connections must explicitly use sslmode=verify-full'
    );
  }

  return url;
}

function validateSolanaRpcUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('SOLANA_RPC_URL is not a valid URL', { cause: error });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(hostname);

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    throw new Error(
      'SOLANA_RPC_URL must use HTTPS; HTTP is allowed only for localhost'
    );
  }

  if (url.username || url.password) {
    throw new Error('SOLANA_RPC_URL must not contain embedded credentials');
  }

  return url.toString();
}

validateDatabaseUrl(DATABASE_URL);
const SOLANA_RPC_ENDPOINT = validateSolanaRpcUrl(SOLANA_RPC_URL);
const encryptionKey = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');

// ============================================================
// PostgreSQL connection pool
// ============================================================

let poolClosed = false;
let poolEndPromise = null;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  min: 0,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 1_800,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: 'blackchin-wallet-engine',
  statement_timeout: 15_000
});

pool.on('error', (error) => {
  console.error('[POSTGRESQL POOL ERROR]', {
    code: error.code ?? 'UNKNOWN',
    message: error.message
  });
});

function assertPoolOpen() {
  if (poolClosed) {
    throw new Error('PostgreSQL connection pool is closed');
  }
}

// ============================================================
// Solana key validation helpers
// ============================================================

function decodeBase58(value) {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 44
  ) {
    throw new Error('Invalid Solana public key length');
  }

  let numericValue = 0n;

  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);

    if (digit < 0) {
      throw new Error('Invalid Base58 character in Solana public key');
    }

    numericValue = numericValue * 58n + BigInt(digit);
  }

  const leadingZeroCount = value.match(/^1*/)?.[0].length ?? 0;

  if (numericValue === 0n) {
    return Buffer.alloc(leadingZeroCount);
  }

  let hex = numericValue.toString(16);

  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  const decoded = Buffer.from(hex, 'hex');

  return Buffer.concat([
    Buffer.alloc(leadingZeroCount),
    decoded
  ]);
}

function validatePublicKey(publicKey) {
  const decoded = decodeBase58(publicKey);

  if (decoded.length !== 32) {
    throw new Error('Solana public key must decode to exactly 32 bytes');
  }

  return decoded;
}

function validatePrivateKey(privateKey) {
  if (
    typeof privateKey !== 'string' ||
    !/^[a-fA-F0-9]{128}$/.test(privateKey)
  ) {
    throw new Error(
      'Invalid Solana private key: expected a 64-byte hexadecimal secret key'
    );
  }

  return Buffer.from(privateKey, 'hex');
}

/**
 * Solana Keypair secretKey is 64 bytes:
 * 32-byte Ed25519 seed followed by 32-byte public key.
 * Verify both the embedded public key and the supplied public key.
 */
function validateKeypair(publicKey, privateKey) {
  const publicKeyBytes = validatePublicKey(publicKey);
  const secretKeyBytes = validatePrivateKey(privateKey);

  const embeddedPublicKey = secretKeyBytes.subarray(32, 64);

  if (!crypto.timingSafeEqual(embeddedPublicKey, publicKeyBytes)) {
    throw new Error('Private key does not match the supplied public key');
  }

  // PKCS#8 DER prefix for an Ed25519 32-byte private seed.
  const pkcs8Prefix = Buffer.from(
    '302e020100300506032b657004220420',
    'hex'
  );

  const privateKeyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      pkcs8Prefix,
      secretKeyBytes.subarray(0, 32)
    ]),
    format: 'der',
    type: 'pkcs8'
  });

  const publicKeyObject = crypto.createPublicKey(privateKeyObject);
  const spki = publicKeyObject.export({
    format: 'der',
    type: 'spki'
  });

  const derivedPublicKey = spki.subarray(spki.length - 32);

  if (!crypto.timingSafeEqual(derivedPublicKey, publicKeyBytes)) {
    throw new Error('Private key seed does not derive the supplied public key');
  }

  return secretKeyBytes;
}

function validateMnemonic(mnemonic) {
  if (
    mnemonic !== null &&
    mnemonic !== undefined &&
    (typeof mnemonic !== 'string' || mnemonic.trim().length === 0)
  ) {
    throw new Error('Mnemonic must be a non-empty string when provided');
  }
}

function validateWallet(wallet) {
  if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) {
    throw new Error('Invalid wallet object');
  }

  validateKeypair(wallet.publicKey, wallet.privateKey);
  validateMnemonic(wallet.mnemonic);
}

// ============================================================
// Authenticated encryption
// ============================================================

function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Encryption input must be a non-empty string');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey,
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  return {
    encryptedData: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

function decrypt(encryptedData, iv, authTag) {
  if (
    typeof encryptedData !== 'string' ||
    !/^(?:[a-fA-F0-9]{2})+$/.test(encryptedData)
  ) {
    throw new Error('Invalid encrypted data format');
  }

  if (
    typeof iv !== 'string' ||
    !new RegExp(`^[a-fA-F0-9]{${IV_LENGTH * 2}}$`).test(iv)
  ) {
    throw new Error('Invalid encryption IV');
  }

  if (
    typeof authTag !== 'string' ||
    !new RegExp(`^[a-fA-F0-9]{${AUTH_TAG_LENGTH * 2}}$`).test(authTag)
  ) {
    throw new Error('Invalid authentication tag');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      encryptionKey,
      Buffer.from(iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedData, 'hex')),
      decipher.final()
    ]);

    return plaintext.toString('utf8');
  } catch (error) {
    throw new Error(
      'Decryption failed: authentication failed or encryption key is incorrect',
      { cause: error }
    );
  }
}

// ============================================================
// Database lifecycle
// ============================================================

export async function connectToPostgres() {
  assertPoolOpen();

  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connection established');
    return pool;
  } catch (error) {
    console.error('[DATABASE CONNECTION FAILED]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}

export async function disconnectPostgres() {
  if (poolClosed) {
    return poolEndPromise;
  }

  poolClosed = true;
  poolEndPromise = pool.end();

  try {
    await poolEndPromise;
    console.log('PostgreSQL connection pool closed');
  } catch (error) {
    poolClosed = false;
    poolEndPromise = null;

    console.error('[DATABASE SHUTDOWN ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}

// ============================================================
// Save wallet
// ============================================================

export async function saveWallet(wallet) {
  validateWallet(wallet);
  assertPoolOpen();

  const encryptedPrivateKey = encrypt(wallet.privateKey);
  const encryptedMnemonic = wallet.mnemonic
    ? encrypt(wallet.mnemonic)
    : null;

  const query = `
    INSERT INTO wallets (
      public_key,
      private_key_encrypted,
      private_key_iv,
      private_key_auth_tag,
      mnemonic_encrypted,
      mnemonic_iv,
      mnemonic_auth_tag
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, public_key, created_at;
  `;

  const values = [
    wallet.publicKey,
    encryptedPrivateKey.encryptedData,
    encryptedPrivateKey.iv,
    encryptedPrivateKey.authTag,
    encryptedMnemonic?.encryptedData ?? null,
    encryptedMnemonic?.iv ?? null,
    encryptedMnemonic?.authTag ?? null
  ];

  try {
    const result = await pool.query(query, values);

    if (result.rowCount !== 1) {
      throw new Error('Wallet insertion did not return exactly one row');
    }

    const savedWallet = result.rows[0];

    console.log('Wallet successfully saved', {
      walletId: savedWallet.id
    });

    return {
      id: savedWallet.id,
      publicKey: savedWallet.public_key,
      createdAt: savedWallet.created_at
    };
  } catch (error) {
    console.error('[WALLET SAVE ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}

// ============================================================
// Load wallet
// ============================================================

export async function loadWallet(index = 0) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('Wallet index must be a non-negative safe integer');
  }

  assertPoolOpen();

  const query = `
    SELECT
      id,
      public_key,
      private_key_encrypted,
      private_key_iv,
      private_key_auth_tag,
      mnemonic_encrypted,
      mnemonic_iv,
      mnemonic_auth_tag,
      created_at
    FROM wallets
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    OFFSET $1;
  `;

  try {
    const result = await pool.query(query, [index]);

    if (result.rowCount === 0) {
      return null;
    }

    const wallet = result.rows[0];

    const privateKey = decrypt(
      wallet.private_key_encrypted,
      wallet.private_key_iv,
      wallet.private_key_auth_tag
    );

    const mnemonic = wallet.mnemonic_encrypted === null
      ? null
      : decrypt(
          wallet.mnemonic_encrypted,
          wallet.mnemonic_iv,
          wallet.mnemonic_auth_tag
        );

    validateKeypair(wallet.public_key, privateKey);

    return {
      id: wallet.id,
      publicKey: wallet.public_key,
      privateKey,
      mnemonic,
      createdAt: wallet.created_at
    };
  } catch (error) {
    console.error('[WALLET LOAD ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}

// ============================================================
// Get wallet count
// ============================================================

export async function getWalletCount() {
  assertPoolOpen();

  try {
    const result = await pool.query(
      'SELECT COUNT(*)::text AS total FROM wallets'
    );

    const total = BigInt(result.rows[0].total);

    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Wallet count exceeds JavaScript safe integer range');
    }

    return Number(total);
  } catch (error) {
    console.error('[WALLET COUNT ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}

// ============================================================
// Solana JSON-RPC
// ============================================================

async function solanaRpc(method, params) {
  const response = await fetch(SOLANA_RPC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params
    }),
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`Solana RPC returned HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (
    !payload ||
    payload.jsonrpc !== '2.0' ||
    !Object.prototype.hasOwnProperty.call(payload, 'result')
  ) {
    if (payload?.error) {
      throw new Error(
        `Solana RPC error ${payload.error.code ?? 'UNKNOWN'}: ${payload.error.message ?? 'Unknown error'}`
      );
    }

    throw new Error('Invalid Solana RPC response');
  }

  return payload.result;
}

// ============================================================
// Get SOL balance by public key
// ============================================================

/**
 * Fetch the native SOL balance for a public key.
 *
 * @param {string} publicKey Base58-encoded Solana public key.
 * @param {'processed'|'confirmed'|'finalized'} commitment
 * @returns {Promise<{
 *   publicKey: string,
 *   network: string,
 *   commitment: string,
 *   lamports: string,
 *   sol: number,
 *   slot: number|null
 * }>}
 */
export async function getSolBalance(
  publicKey,
  commitment = 'confirmed'
) {
  validatePublicKey(publicKey);

  if (!SOLANA_COMMITMENTS.has(commitment)) {
    throw new Error('Invalid Solana commitment');
  }

  try {
    const result = await solanaRpc('getBalance', [
      publicKey,
      { commitment }
    ]);

    if (
      !result ||
      !Number.isSafeInteger(result.value) ||
      result.value < 0
    ) {
      throw new Error('Invalid or unsafe balance returned by Solana RPC');
    }

    const lamports = BigInt(result.value);

    return {
      publicKey,
      network: SOLANA_NETWORK,
      commitment,
      lamports: lamports.toString(),
      sol: Number(lamports) / Number(LAMPORTS_PER_SOL),
      slot: Number.isSafeInteger(result.context?.slot)
        ? result.context.slot
        : null
    };
  } catch (error) {
    console.error('[SOLANA BALANCE ERROR]', {
      message: error.message
    });

    throw error;
  }
}

// ============================================================
// Get SOL balance for a wallet stored in PostgreSQL
// ============================================================

/**
 * Fetch the SOL balance for the wallet at the requested zero-based index.
 *
 * @param {number} index
 * @param {'processed'|'confirmed'|'finalized'} commitment
 */
export async function getWalletSolBalance(
  index = 0,
  commitment = 'confirmed'
) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('Wallet index must be a non-negative safe integer');
  }

  assertPoolOpen();

  try {
    const result = await pool.query(
      `
        SELECT public_key
        FROM wallets
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        OFFSET $1;
      `,
      [index]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const publicKey = result.rows[0].public_key;
    const balance = await getSolBalance(publicKey, commitment);

    return {
      walletIndex: index,
      ...balance
    };
  } catch (error) {
    console.error('[WALLET BALANCE ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}
