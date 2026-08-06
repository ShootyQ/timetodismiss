Param(
  [string]$ProjectId = "dismissalcaller",
  [switch]$All
)

Write-Host "=== TimeToDismiss Deploy Helper ===" -ForegroundColor Cyan

# 1. Ensure firebase-tools exists
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  Write-Host "firebase CLI not found. Installing globally..." -ForegroundColor Yellow
  npm install -g firebase-tools
  if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
    Write-Error "Firebase CLI still not found after install. Abort."; exit 1
  }
}

# 2. Show CLI version
firebase --version

# 3. Confirm login
try {
  $acct = firebase login:list 2>$null | Select-String "Active" | ForEach-Object { $_.ToString() }
  if (-not $acct) {
    Write-Host "No active login; launching 'firebase login'..." -ForegroundColor Yellow
    firebase login
  } else {
    Write-Host "Logged in user: $acct" -ForegroundColor Green
  }
} catch { firebase login }

# 4. Set project
Write-Host "Using project: $ProjectId" -ForegroundColor Cyan
firebase use $ProjectId
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to select project $ProjectId"; exit 1 }

# 5. Install function deps
if (Test-Path functions/package.json) {
  Write-Host "Installing functions dependencies..." -ForegroundColor Cyan
  pushd functions
  npm install --no-audit --no-fund
  popd
} else { Write-Error "functions/package.json not found"; exit 1 }

# 6. Determine function names from index.js
$indexPath = Join-Path functions 'index.js'
if (-not (Test-Path $indexPath)) { Write-Error "functions/index.js missing"; exit 1 }
$src = Get-Content $indexPath -Raw
$exports = Select-String -InputObject $src -Pattern "exports\\.(\\w+)\s*=\s*onCall" -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Host "Detected callable exports: $($exports -join ', ')" -ForegroundColor Gray

$target = @(
  'setTeacherClasses','listSchoolClasses','listSchoolMembers',
  'getAftercareAdminData','saveAftercareSettings','saveAftercareFamily',
  'archiveAftercareFamily','clockInAftercareStudent','clockOutAftercareStudent',
  'getAftercareReport','autoCloseAftercareSessions'
)
$present = $exports | Where-Object { $_ -in $target }

if ($All -or $present.Count -eq 0) {
  Write-Host "Deploying ALL functions (flag --All or missing target functions)." -ForegroundColor Yellow
  firebase deploy --only functions
} else {
  $arg = 'functions:' + ($present -join ',functions:')
  Write-Host "Deploying: $arg" -ForegroundColor Cyan
  firebase deploy --only $arg
}

if ($LASTEXITCODE -ne 0) { Write-Error "Deployment failed."; exit 1 }

Write-Host "Deployment complete." -ForegroundColor Green

# 7. Quick post-deploy verification: list functions
Write-Host "Listing deployed functions (filtered)" -ForegroundColor Cyan
firebase functions:list | Select-String -Pattern "setTeacherClasses|listSchoolClasses|listSchoolMembers|getAftercareAdminData|saveAftercareSettings|saveAftercareFamily|archiveAftercareFamily|clockInAftercareStudent|clockOutAftercareStudent|getAftercareReport|autoCloseAftercareSessions"

Write-Host "If functions show as 'ACTIVE', you can hard reload the Roles page now." -ForegroundColor Green
