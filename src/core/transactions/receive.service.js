import { solanaAdapter } from '../../blockchain/solana/solana.adapter.js';

export async function getDepositAddress(publicKey) {
  return solanaAdapter.getDepositAddress(publicKey);
}

export async function getIncomingTransactions(publicKey, limit = 10) {
  return solanaAdapter.getRecentIncomingTransfers(publicKey, { limit });
}

export async function verifyIncomingTransaction(signature, publicKey) {
  return solanaAdapter.verifyIncomingTransfer(signature, publicKey);
}
