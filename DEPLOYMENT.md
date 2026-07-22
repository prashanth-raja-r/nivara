# Deploying Nivara

Nivara uses a Vercel-hosted React web app, a Render-hosted Node API, a managed PostgreSQL database, and a private S3-compatible document bucket.

## 1. Create production services

1. Create a PostgreSQL database in Neon, Render Postgres, or another managed provider.
2. Create a private S3-compatible bucket. Cloudflare R2, Amazon S3, and Backblaze B2 work with the provided configuration.
3. Push this repository to a private Git repository.

## 2. Deploy the API on Render

Create a Render Blueprint from this repository. The included `render.yaml` builds the API, runs Prisma migrations before deployment, and starts the service.

Set these secrets in the Render service:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=<generate-a-long-random-value>
GOOGLE_CLIENT_ID=<your-web-client-id>
FRONTEND_URL=https://your-app.vercel.app,https://app.yourdomain.com
S3_BUCKET=nivara-documents
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<bucket-access-key>
S3_SECRET_ACCESS_KEY=<bucket-secret>
S3_FORCE_PATH_STYLE=false
```

Never expose `DATABASE_URL`, `JWT_SECRET`, or the S3 access keys to the browser.

## 3. Deploy the web app on Vercel

Import the repository into Vercel. The included `vercel.json` builds `apps/web` and publishes `apps/web/dist`.

Add these Vercel environment variables:

```env
VITE_API_URL=https://your-api.onrender.com
VITE_GOOGLE_CLIENT_ID=<your-web-client-id>
```

`VITE_` variables are browser-visible; do not put secrets in them.

## 4. Configure Google sign-in and custom domains

In Google Cloud Console, add both the Vercel URL and the final custom domain as Authorized JavaScript origins. Set the same production web URL in Render's `FRONTEND_URL` value.

## 5. Migrate safely

Production deployments run this automatically through `render.yaml`:

```sh
npm run db:deploy
```

For an existing local database created before loan ownership was added, explicitly assign unowned legacy loans to their real account once:

```sh
npm run db:assign-legacy-loans -- owner@example.com
```

This command only updates loans with no owner. New loans are always assigned from the authenticated JWT and cannot be read by any other account.

## Pre-launch checklist

- Confirm sign-up, password login, and Google login.
- Confirm a second account cannot read the first account's loans, payments, exports, documents, or profile.
- Upload and download a test document from the production bucket.
- Confirm Google sign-in works at the final HTTPS domain.
- Set a custom domain and test the final URL before inviting users.
