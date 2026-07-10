# timetodismiss
Dismissal Platform for Schools

## Deployments

This repo uses GitHub Actions to deploy to Firebase Hosting.

- Dev previews: on pushes to `aftercare-dev` or manual runs
	- Workflow: `.github/workflows/deploy-dev-hosting.yml`
	- Creates a Hosting preview channel named `dev` that auto-expires in 7 days
	- URL: https://dev--dismissalcaller.web.app (stable named channel URL)
	- Deploys Hosting only; it does not modify Firestore rules, indexes, or Functions

- Production: on pushes to `main` or manual runs
	- Workflow: `.github/workflows/deploy-live-on-main.yml`
	- Deploys to the live site `https://dismissalcaller.web.app` (and custom domains if configured)

### Prerequisites

Add the following repository secret in GitHub → Settings → Secrets and variables → Actions:

- `FIREBASE_SERVICE_ACCOUNT_DISMISSALCALLER`: contents of a Firebase service account JSON key with role `Firebase Hosting Admin` on project `dismissalcaller`.

### Manually run a deploy

1) Go to the Actions tab.
2) Choose the workflow (Dev or Live).
3) Click “Run workflow” and select a branch (e.g., `aftercare-dev` for previews or `main` for live).

### Verify dev preview

- Open the Actions run log for the dev workflow; the job summary prints the preview URL.
- Or visit: https://dev--dismissalcaller.web.app

### Hosting configuration

`firebase.json` includes a Hosting target with:

- site: `dismissalcaller`
- public: `.` (serves static files from repo root)
- cleanUrls enabled

## Analytics

- Google Analytics 4 is initialized globally from `site-header.js` using Measurement ID `G-2799S6XEND`.
- To change the GA property later, update the `GA_MEASUREMENT_ID` constant and the `measurementId` inside the `firebaseConfig` block in `site-header.js`.
- The GA script loads asynchronously on every page that includes `site-header.js` (most pages). Page views are tracked automatically.
