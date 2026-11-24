/**
 * Contract for protecting per-envelope data-encryption keys (DEKs).
 *
 * Implementations must never persist or log plaintext DEKs. The caller owns
 * the returned plaintext Buffer from unwrapKey() and must zero it promptly.
 *
 * Vault Transit is the local/development implementation. A future PKCS#11
 * adapter can implement the same contract using an HSM KEK without changing
 * the envelope format or wallet services.
 */
export function assertEnvelopeKeyProvider(provider) {
  if (!provider || typeof provider !== 'object' ||
      typeof provider.wrapKey !== 'function' ||
      typeof provider.unwrapKey !== 'function') {
    throw new TypeError('Envelope key provider must implement wrapKey() and unwrapKey()');
  }
  if (!Number.isSafeInteger(provider.currentVersion) || provider.currentVersion < 1) {
    throw new TypeError('Envelope key provider must expose a positive currentVersion');
  }
  return provider;
}
