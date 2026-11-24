# Signer-only policy. Do not attach this policy to the public API identity.
# Production deployments must use a non-dev Vault server, TLS, audited auth
# method, short-lived tokens, and separate encrypt/decrypt capabilities.
path "transit/encrypt/blackchin-envelope" {
  capabilities = ["update"]
}

path "transit/decrypt/blackchin-envelope" {
  capabilities = ["update"]
}

path "transit/keys/blackchin-envelope" {
  capabilities = ["read"]
}
