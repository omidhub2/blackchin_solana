/**
 * SLIP-0010 Ed25519 hierarchical deterministic derivation.
 *
 * Ed25519 is implemented with hardened derivation only, as required by
 * SLIP-0010 (there is no public/non-hardened child key derivation).
 *
 * Reference: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 *
 * The derivation is implemented locally on top of Node's HMAC-SHA512 so the
 * exact standard version is explicit and tested against known vectors.
 */
import crypto from 'node:crypto';

const HARDENED_OFFSET = 0x80000000;
const MAX_INDEX = HARDENED_OFFSET - 1;
const SEED_MIN_BYTES = 16;
const SEED_MAX_BYTES = 64;

export const SLIP10_CURVE = 'ed25519';

function hmacSha512(key, data) {
  return crypto.createHmac('sha512', key).update(data).digest();
}

/**
 * Derive the SLIP-0010 master node from a BIP39 seed.
 *
 * @param {Uint8Array|Buffer} seed BIP39 seed (64 bytes for 256-bit entropy).
 * @returns {{ key: Buffer, chainCode: Buffer }} 32-byte private key and chain code.
 */
export function deriveSlip10MasterKey(seed) {
  const seedBytes = Buffer.from(seed);

  if (seedBytes.length < SEED_MIN_BYTES || seedBytes.length > SEED_MAX_BYTES) {
    throw new TypeError(
      `SLIP-0010 seed must be between ${SEED_MIN_BYTES} and ${SEED_MAX_BYTES} bytes`
    );
  }

  const digest = hmacSha512(Buffer.from('ed25519 seed', 'utf8'), seedBytes);

  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32)
  };
}

/**
 * Derive one hardened child node.
 *
 * @param {{ key: Buffer, chainCode: Buffer }} parent
 * @param {number} index Child index (set bit 31 is applied automatically).
 */
export function deriveSlip10ChildKey(parent, index) {
  if (!parent || !Buffer.isBuffer(parent.key) || parent.key.length !== 32) {
    throw new TypeError('Parent node must contain a 32-byte private key');
  }

  if (!Buffer.isBuffer(parent.chainCode) || parent.chainCode.length !== 32) {
    throw new TypeError('Parent node must contain a 32-byte chain code');
  }

  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError(`Derivation index must be an integer between 0 and ${MAX_INDEX}`);
  }

  const indexBuffer = Buffer.alloc(4);
  indexBuffer.writeUInt32BE((index + HARDENED_OFFSET) >>> 0, 0);

  const data = Buffer.concat([Buffer.from([0x00]), parent.key, indexBuffer]);
  const digest = hmacSha512(parent.chainCode, data);

  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32)
  };
}

/**
 * Parse a hardened Solana derivation path such as `m/44'/501'/0'/0'`.
 *
 * @param {string} path
 * @returns {number[]} numeric indices without the hardened offset
 */
export function parseHardenedPath(path) {
  if (typeof path !== 'string' || !/^m(\/\d+')+$/.test(path)) {
    throw new TypeError(
      "Derivation path must be a hardened path such as m/44'/501'/0'/0'"
    );
  }

  const indices = path
    .split('/')
    .slice(1)
    .map((segment) => {
      const index = Number(segment.slice(0, -1));

      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
        throw new RangeError(`Derivation path index ${segment} is out of range`);
      }

      return index;
    });

  if (indices.length === 0 || indices.length > 16) {
    throw new TypeError('Derivation path must contain between 1 and 16 levels');
  }

  return indices;
}

/**
 * Derive a node by walking a hardened path from the master node.
 */
export function deriveSlip10Path(masterNode, path) {
  const indices = parseHardenedPath(path);
  let node = masterNode;
  let owned = [];

  try {
    for (const index of indices) {
      const next = deriveSlip10ChildKey(node, index);

      // Intermediate nodes are owned by this function and wiped as soon as
      // the next level exists. The caller's master node is never touched.
      for (const previous of owned) {
        previous.key.fill(0);
        previous.chainCode.fill(0);
      }

      owned = [];
      if (next !== masterNode) owned.push(next);
      node = next;
    }

    owned = [];
    return node;
  } catch (error) {
    for (const held of owned) {
      held.key.fill(0);
      held.chainCode.fill(0);
    }

    throw error;
  }
}

export const SLIP10_HARDENED_OFFSET = HARDENED_OFFSET;
export const SLIP10_MAX_INDEX = MAX_INDEX;
