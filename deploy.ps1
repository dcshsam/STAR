# deploy.ps1 — Push STAR to SAP BTP Cloud Foundry (us10-001)
# Run from the repo root:  .\deploy.ps1
#
# Prerequisites:
#   1. CF CLI installed — winget install CloudFoundry.cli
#      (or download from https://github.com/cloudfoundry/cli/releases)
#   2. Node.js 18+ installed locally (for frontend build)
#   3. You are logged in to BTP and have a Cloud Foundry environment enabled
#      in your subaccount (BTP Cockpit → Subaccount → Cloud Foundry → Enable)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$API       = "https://api.cf.us10-001.hana.ondemand.com"
$BACK_APP  = "star-backend"
$FRONT_APP = "star-web"
$BACK_URL  = "https://star-backend.cfapps.us10-001.hana.ondemand.com"
$FRONT_URL = "https://star-web.cfapps.us10-001.hana.ondemand.com"

# ─────────────────────────────────────────────────────────────────────────────
function Confirm-Tool($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "$name not found. Install it and re-run this script."
        exit 1
    }
}

Confirm-Tool "cf"
Confirm-Tool "npm"

Write-Host "`n╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   STAR — BTP Cloud Foundry Deployment    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝`n" -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Target CF API and log in
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[1/6] Targeting CF API and logging in..." -ForegroundColor Yellow
cf api $API
cf login
Write-Host "      Logged in OK." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Push backend (no-start so we can set secrets first)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n[2/6] Pushing backend (Python/FastAPI, no-start)..." -ForegroundColor Yellow
Push-Location "$PSScriptRoot\backend"
cf push $BACK_APP --no-start
Pop-Location

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Inject secrets via cf set-env (they never appear in any file)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n[3/6] Setting backend secrets (input hidden)..." -ForegroundColor Yellow

# SECRET_KEY
$sk = Read-Host "  SECRET_KEY (leave blank to auto-generate)" -AsSecureString
$skPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sk))
if ([string]::IsNullOrWhiteSpace($skPlain)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
    $skPlain = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Write-Host "  (auto-generated a 32-byte hex SECRET_KEY)"
}
cf set-env $BACK_APP SECRET_KEY $skPlain

# Admin password
$pw = Read-Host "  FIRST_ADMIN_PASSWORD for user 'admin'" -AsSecureString
$pwPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
if ([string]::IsNullOrWhiteSpace($pwPlain)) {
    Write-Error "Admin password cannot be empty."
    exit 1
}
cf set-env $BACK_APP FIRST_ADMIN_PASSWORD $pwPlain

# Optional: Anthropic API key
$ak = Read-Host "  ANTHROPIC_API_KEY (leave blank to skip LLM narrative)" -AsSecureString
$akPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ak))
if (-not [string]::IsNullOrWhiteSpace($akPlain)) {
    cf set-env $BACK_APP ANTHROPIC_API_KEY $akPlain
    cf set-env $BACK_APP USE_LLM_NARRATIVE "true"
    Write-Host "  LLM narrative enabled (Anthropic)." -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — Start backend and verify
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n[4/6] Starting backend..." -ForegroundColor Yellow
cf start $BACK_APP

Write-Host "      Waiting 10 s for startup..." -ForegroundColor Gray
Start-Sleep -Seconds 10

try {
    $resp = Invoke-RestMethod "$BACK_URL/health" -TimeoutSec 20
    Write-Host "      Backend healthy: status=$($resp.status)" -ForegroundColor Green
} catch {
    Write-Warning "      Health check failed — check: cf logs $BACK_APP --recent"
    Write-Warning "      Continuing with frontend deployment..."
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Build frontend locally (NEXT_PUBLIC_API_URL is baked at build time)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n[5/6] Building frontend with backend URL baked in..." -ForegroundColor Yellow
Push-Location "$PSScriptRoot\frontend"

$env:NEXT_PUBLIC_API_URL = $BACK_URL
Write-Host "      NEXT_PUBLIC_API_URL=$($env:NEXT_PUBLIC_API_URL)"

if (-not (Test-Path "node_modules")) {
    Write-Host "      Running npm install..."
    npm install
}

Write-Host "      Running npm run build (this takes ~60 s)..."
npm run build

Write-Host "      Pushing frontend to CF (includes pre-built .next/)..."
cf push $FRONT_APP

Pop-Location

# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — Summary
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n[6/6] Deployment complete!" -ForegroundColor Green
Write-Host @"

  ┌─────────────────────────────────────────────────────────────┐
  │  Frontend : $FRONT_URL  │
  │  Backend  : $BACK_URL   │
  │  Health   : $BACK_URL/health  │
  │  API docs : $BACK_URL/docs    │
  └─────────────────────────────────────────────────────────────┘

  Login: admin / <password you entered>
         architect / star2026  (demo read-only)

  IMPORTANT — SQLite is ephemeral on CF.
  User portfolios are lost on restage/restart. The admin user is
  re-seeded automatically. For persistence, bind SAP HANA Cloud
  and update DATABASE_URL via: cf set-env $BACK_APP DATABASE_URL <url>

  To redeploy after changes:
    Backend:  cd backend  && cf push $BACK_APP
    Frontend: $env:NEXT_PUBLIC_API_URL="$BACK_URL"; cd frontend; npm run build; cf push $FRONT_APP

  Live logs:
    cf logs $BACK_APP  --recent
    cf logs $FRONT_APP --recent
"@
