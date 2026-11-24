$ErrorActionPreference = "Stop"
$container = "blackchin-vault-dev"
$rootToken = "blackchin-local-dev-root-token"

Write-Host "Checking local Vault container..."
docker exec $container vault status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Vault is not ready. Start it with: npm run vault:local:up" }

function Invoke-VaultCli([string[]]$Arguments) {
  docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e "VAULT_TOKEN=$rootToken" $container vault @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Vault CLI command failed: vault $($Arguments -join ' ')" }
}

Write-Host "Enabling Transit engine if needed..."
$engineJson = Invoke-VaultCli @("secrets", "list", "-format=json")
$engines = $engineJson | ConvertFrom-Json
if (-not $engines.PSObject.Properties.Name.Contains("transit/")) {
  Invoke-VaultCli @("secrets", "enable", "transit") | Out-Null
}

Write-Host "Creating BLACKCHIN envelope key if needed..."
$keyJson = Invoke-VaultCli @("list", "-format=json", "transit/keys")
$keys = @()
if ($keyJson) { $keys = @($keyJson | ConvertFrom-Json) }
if ($keys -notcontains "blackchin-envelope") {
  Invoke-VaultCli @("write", "-f", "transit/keys/blackchin-envelope", "type=aes256-gcm96", "exportable=false", "allow_plaintext_backup=false") | Out-Null
}

Write-Host "Installing signer-only policy..."
Invoke-VaultCli @("policy", "write", "blackchin-signer", "/dev/stdin") < infra/local/vault/policies/blackchin-signer.hcl | Out-Null

Write-Host "Creating a short-lived local signer token..."
$tokenOutput = Invoke-VaultCli @("token", "create", "-policy=blackchin-signer", "-ttl=1h", "-renewable=true", "-field=token")
$signerToken = ($tokenOutput | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($signerToken)) {
  throw "Vault did not return a signer token."
}

Write-Host ""
Write-Host "Signer token (save only in an untracked local .env.local file):"
Write-Host $signerToken
Write-Host ""
Write-Host "WARNING: local Vault dev mode is in-memory and uses a root token."
Write-Host "Never use this token, key, or configuration in production."
