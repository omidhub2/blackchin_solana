/**
 * Solana blockchain adapter.
 *
 * Thin, frozen facade over Solana/solTransfer.js so core services depend on an
 * injectable interface instead of importing chain code directly.
 */
import {
  getDepositAddress,
  getRecentIncomingTransfers,
  getSolBalance,
  verifyIncomingTransfer,
  estimateSolTransfer,
  sendSol,
  sendSolWithSigner
} from '../../../Solana/solTransfer.js';

export const solanaAdapter = Object.freeze({
  getDepositAddress,
  getRecentIncomingTransfers,
  getSolBalance,
  verifyIncomingTransfer,
  estimateSolTransfer,
  sendSol,
  sendSolWithSigner
});
