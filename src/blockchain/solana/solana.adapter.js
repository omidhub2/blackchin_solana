import {
  getDepositAddress,
  getRecentIncomingTransfers,
  getSolBalance,
  verifyIncomingTransfer,
  estimateSolTransfer,
  sendSol
} from '../../../Solana/solTransfer.js';

export const solanaAdapter = Object.freeze({
  getDepositAddress,
  getRecentIncomingTransfers,
  getSolBalance,
  verifyIncomingTransfer,
  estimateSolTransfer,
  sendSol
});
