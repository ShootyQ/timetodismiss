# timetodismiss
Dismissal Platform for Schools

## Deployments

This repo uses GitHub Actions to deploy to Firebase Hosting.

- Dev previews: on pushes to `aftercare-dev` or manual runs
	- Workflow: `.github/workflows/deploy-dev-hosting.yml`
	- Creates a Hosting preview channel named `dev` that auto-expires in 7 days
	- URL: https://dev--dismissalcaller.web.app (stable named channel URL)
	- Deploys Hosting only; it does not modify Firestore rules, indexes, or Functions
	- Hosting preview channels still use the configured `dismissalcaller` Firebase project for Auth, Firestore, and Functions

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
- Aftercare operator page: `/aftercare`
- Aftercare management page: `/aftercare-manage`
- The Hosting workflow does not deploy Functions, Firestore rules, or indexes. Deploy the Aftercare Functions separately only when the target Firebase project is ready for them.

### Deploy Aftercare Functions

From GitHub Actions, run the `Deploy Aftercare Functions` workflow manually, enter `deploy-functions` for confirmation, and choose the Firebase project. It deploys the targeted Aftercare callables and `autoCloseAftercareSessions` without deploying Firestore rules or indexes. The `FIREBASE_SERVICE_ACCOUNT_DISMISSALCALLER` secret must have Functions deployment permissions; Hosting Admin alone is insufficient. The workflow updates the selected project's Functions backend, while Hosting preview channels still share that project's Auth and Firestore.

For a local clone, the equivalent PowerShell command is `./deploy.ps1 -ProjectId dismissalcaller`. The repository now targets the Node 20 Functions runtime.

### Hosting configuration

`firebase.json` includes a Hosting target with:

- site: `dismissalcaller`
- public: `.` (serves static files from repo root)
- cleanUrls enabled

## Analytics

- Google Analytics 4 is initialized globally from `site-header.js` using Measurement ID `G-2799S6XEND`.
- To change the GA property later, update the `GA_MEASUREMENT_ID` constant and the `measurementId` inside the `firebaseConfig` block in `site-header.js`.
- The GA script loads asynchronously on every page that includes `site-header.js` (most pages). Page views are tracked automatically.
