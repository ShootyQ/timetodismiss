Param(
  [string]$DevRoot = "C:\\Users\\Andre\\DEVCaller",
  [string]$ProjectId = "dismissalcallerdev",
  [switch]$NoDeploy
)

Write-Host "=== Dev Firebase Setup (Copy + Deploy) ===" -ForegroundColor Cyan
Write-Host "Dev root: $DevRoot" -ForegroundColor Gray
Write-Host "Project:  $ProjectId" -ForegroundColor Gray

# Resolve repo root for source files
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ensure destination structure
New-Item -ItemType Directory -Force -Path $DevRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DevRoot 'functions') | Out-Null

# Copy Firestore rules and indexes
$rulesSrc   = Join-Path $RepoRoot 'firestore.rules'
$indexesSrc = Join-Path $RepoRoot 'firestore.indexes.json'
if (!(Test-Path $rulesSrc)) { Write-Error "Missing $rulesSrc"; exit 1 }
if (!(Test-Path $indexesSrc)) { Write-Error "Missing $indexesSrc"; exit 1 }
Copy-Item $rulesSrc   -Destination (Join-Path $DevRoot 'firestore.rules') -Force
Copy-Item $indexesSrc -Destination (Join-Path $DevRoot 'firestore.indexes.json') -Force

# Copy Cloud Functions source (index.js + package.json)
$funcSrcDir = Join-Path $RepoRoot 'functions'
if (!(Test-Path (Join-Path $funcSrcDir 'index.js'))) { Write-Error 'Missing functions/index.js in repo'; exit 1 }
Copy-Item (Join-Path $funcSrcDir 'index.js')      -Destination (Join-Path $DevRoot 'functions/index.js') -Force
Copy-Item (Join-Path $funcSrcDir 'package.json')  -Destination (Join-Path $DevRoot 'functions/package.json') -Force
if (Test-Path (Join-Path $funcSrcDir 'package-lock.json')) {
  Copy-Item (Join-Path $funcSrcDir 'package-lock.json') -Destination (Join-Path $DevRoot 'functions/package-lock.json') -Force
}

# Write firebase.json (functions + firestore only)
$firebaseJson = @{
  functions = @{ source = 'functions'; runtime = 'nodejs18' }
  firestore = @{ rules = 'firestore.rules'; indexes = 'firestore.indexes.json' }
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $DevRoot 'firebase.json') -Value $firebaseJson -Encoding UTF8

# Write .firebaserc with default pointing to the dev project
$firebaserc = @{ projects = @{ default = $ProjectId; dev = $ProjectId } } | ConvertTo-Json -Depth 3
Set-Content -Path (Join-Path $DevRoot '.firebaserc') -Value $firebaserc -Encoding UTF8

Write-Host "Files prepared under $DevRoot" -ForegroundColor Green

if ($NoDeploy) { Write-Host "NoDeploy flag set; skipping deploy." -ForegroundColor Yellow; exit 0 }

# Ensure Firebase CLI
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Firebase CLI globally..." -ForegroundColor Yellow
  npm install -g firebase-tools
  if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) { Write-Error "Firebase CLI not found after install"; exit 1 }
}

# Login if needed
try {
  $null = firebase login:list 2>$null
} catch { firebase login }

# Install function deps
Push-Location (Join-Path $DevRoot 'functions')
try {
  if (Test-Path 'package.json') {
    Write-Host "Installing dev functions dependencies..." -ForegroundColor Cyan
    npm install --no-audit --no-fund
  }
} finally { Pop-Location }

# Deploy rules, indexes, functions to the dev project
Write-Host "Deploying to $ProjectId..." -ForegroundColor Cyan
Push-Location $DevRoot
try {
  firebase deploy --project $ProjectId --only firestore:rules,firestore:indexes,functions
} finally { Pop-Location }

if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed."; exit 1 }
Write-Host "Dev deploy complete." -ForegroundColor Green
