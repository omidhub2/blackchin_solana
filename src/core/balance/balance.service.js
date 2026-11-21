import { solanaAdapter } from '../../blockchain/solana/solana.adapter.js';

export async function getWalletBalance(publicKey) {
  return solanaAdapter.getSolBalance(publicKey);
}
