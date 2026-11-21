import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Connection } from '@solana/web3.js';

// ============================================================
// Environment configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '../.env')
});

const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';

const DEFAULT_RPC_ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};

const RPC_ENDPOINT =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL ||
  DEFAULT_RPC_ENDPOINTS[SOLANA_NETWORK];

const COMMITMENT = process.env.SOLANA_COMMITMENT || 'confirmed';

const VALID_COMMITMENTS = new Set([
  'processed',
  'confirmed',
  'finalized'
]);

// ============================================================
// Configuration validation
// ============================================================

if (!Object.prototype.hasOwnProperty.call(
  DEFAULT_RPC_ENDPOINTS,
  SOLANA_NETWORK
)) {
  throw new Error(
    'SOLANA_NETWORK must be devnet, testnet or mainnet-beta'
  );
}

if (!RPC_ENDPOINT) {
  throw new Error(
    'Solana RPC endpoint is missing. Set SOLANA_RPC_URL in .env'
  );
}

if (!VALID_COMMITMENTS.has(COMMITMENT)) {
  throw new Error(
    'SOLANA_COMMITMENT must be processed, confirmed or finalized'
  );
}

function validateRpcEndpoint(endpoint) {
  let url;

  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error('Solana RPC endpoint is not a valid URL', {
      cause: error
    });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = [
    'localhost',
    '127.0.0.1',
    '::1'
  ].includes(hostname);

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocalhost)
  ) {
    throw new Error(
      'Solana RPC endpoint must use HTTPS; HTTP is allowed only for localhost'
    );
  }

  if (url.username || url.password) {
    throw new Error(
      'Do not embed credentials in the Solana RPC endpoint URL'
    );
  }

  return url.toString();
}

const validatedRpcEndpoint = validateRpcEndpoint(RPC_ENDPOINT);

// Optional dedicated WebSocket endpoint. When omitted, web3.js derives
// the WebSocket endpoint from the HTTP(S) RPC endpoint.
const WS_ENDPOINT = process.env.SOLANA_WS_URL || undefined;

function validateWebSocketEndpoint(endpoint) {
  if (!endpoint) {
    return undefined;
  }

  let url;

  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error('SOLANA_WS_URL is not a valid URL', {
      cause: error
    });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = [
    'localhost',
    '127.0.0.1',
    '::1'
  ].includes(hostname);

  if (
    url.protocol !== 'wss:' &&
    !(url.protocol === 'ws:' && isLocalhost)
  ) {
    throw new Error(
      'SOLANA_WS_URL must use WSS; WS is allowed only for localhost'
    );
  }

  if (url.username || url.password) {
    throw new Error(
      'Do not embed credentials in the Solana WebSocket URL'
    );
  }

  return url.toString();
}

const validatedWsEndpoint = validateWebSocketEndpoint(WS_ENDPOINT);

// ============================================================
// Solana connection
// ============================================================

const connectionConfig = {
  commitment: COMMITMENT,
  confirmTransactionInitialTimeout: 60_000
};

if (validatedWsEndpoint) {
  connectionConfig.wsEndpoint = validatedWsEndpoint;
}

/**
 * Shared Solana JSON-RPC connection.
 *
 * Uses SOLANA_RPC_URL as the canonical environment variable.
 * RPC_URL remains supported as a backward-compatible fallback.
 *
 * @type {Connection}
 */
export const connection = new Connection(
  validatedRpcEndpoint,
  connectionConfig
);

export const solanaNetwork = SOLANA_NETWORK;
export const rpcEndpoint = validatedRpcEndpoint;
export const commitment = COMMITMENT;
