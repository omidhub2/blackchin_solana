$ErrorActionPreference = "Stop"

$env:VAULT_ADDR = "http://127.0.0.1:8200"
$env:VAULT_TOKEN = "blackchin-local-dev-root-token"

Write-Host "Checking local Vault..."
vault status | Out-Null

Write-Host "Enabling Transit engine if needed..."
$engines = vault secrets list -format=json | ConvertFrom-Json
if (-not $engines.PSObject.Properties.Name.Contains("transit/")) {
  vault secrets enable transit | Out-Null
}

Write-Host "Creating BLACKCHIN envelope key if needed..."
$keys = vault list -format=json transit/keys 2>$null
if ($LASTEXITCODE -ne 0 -or ($keys | ConvertFrom-Json) -notcontains "blackchin-envelope") {
  vault write -f transit/keys/blackchin-envelope type=aes256-gcm96 exportable=false allow_plaintext_backup=false | Out-Null
}

Write-Host "Installing signer-only policy..."
vault policy write blackchin-signer infra/local/vault/policies/blackchin-signer.hcl | Out-Null

Write-Host "Creating a short-lived local signer token..."
$signerToken = vault token create -policy=blackchin-signer -ttl=1h -renewable=true -field=token
if ([string]::IsNullOrWhiteSpace($signerToken)) {
  throw "Vault did not return a signer token."
}

Write-Host ""
Write-Host "Local signer token (store it in an untracked .env.local file; do not commit):"
Write-Host $signerToken
Write-Host ""
Write-Host "WARNING: this is a local-only Vault dev setup with an in-memory root token."
Write-Host "Never reuse this token, key, or configuration in production."
