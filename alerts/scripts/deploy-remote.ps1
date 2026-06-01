# Deploy Turbolong alerts worker (D1 + VAPID secrets + worker).
# Prereq: npx wrangler login  (or CLOUDFLARE_API_TOKEN in env)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "Checking Wrangler auth..."
$whoami = npx wrangler whoami 2>&1 | Out-String
if ($whoami -match "not authenticated") {
  Write-Host "Run: npx wrangler login"
  exit 1
}

if ((Get-Content wrangler.toml -Raw) -match 'database_id = "<run') {
  Write-Host "Creating D1 database..."
  $out = npx wrangler d1 create turbolong-alerts 2>&1 | Out-String
  Write-Host $out
  if ($out -match 'database_id = "([a-f0-9-]+)"') {
    $id = $Matches[1]
    (Get-Content wrangler.toml -Raw) -replace 'database_id = "<[^"]+>"', "database_id = `"$id`"" |
      Set-Content wrangler.toml -NoNewline
    Write-Host "Updated wrangler.toml with database_id $id"
  } else {
    Write-Host "Could not parse database_id from wrangler output. Paste it into wrangler.toml manually."
    exit 1
  }
}

Write-Host "Migrating remote D1..."
npm run db:migrate:remote

$devVars = Get-Content .dev.vars -Raw
if ($devVars -notmatch 'VAPID_PRIVATE_KEY=(.+)') {
  Write-Host "Missing VAPID_PRIVATE_KEY in alerts/.dev.vars — run: npm run vapid:generate"
  exit 1
}
$jwk = $Matches[1].Trim()

Write-Host "Setting VAPID_PRIVATE_KEY secret..."
$jwk | npx wrangler secret put VAPID_PRIVATE_KEY

if (-not $env:SKIP_RESEND_SECRET) {
  Write-Host "Set RESEND_API_KEY if not already set (interactive):"
  npx wrangler secret put RESEND_API_KEY
}

Write-Host "Deploying worker..."
npm run deploy

Write-Host "Done. Worker: https://turbolong-alerts.workers.dev"
