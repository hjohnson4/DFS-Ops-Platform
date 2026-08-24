# Deploying DFS Ops to Vercel

The app now supports two runtime targets from one codebase:

| Target | Entry | Build command | Server model |
| --- | --- | --- | --- |
| pplx.app / standalone | `server/index.ts` → `dist/index.cjs` | `npm run build` | Long-running Express (`listen`) |
| **Vercel** | `api/index.ts` (serverless function) | `npm run build:vercel` | Serverless (per-request) |

Both share `server/app.ts` (`createApp()`), which builds the Express app and
registers all `/api` routes. The standalone server adds `listen()` + static
serving; the Vercel function only handles the API, and Vercel's CDN serves the
static frontend from `dist/public`.

## How the Vercel wiring works (`vercel.json`)

- `buildCommand: npm run build:vercel` — builds the client only (`dist/public`).
- `outputDirectory: dist/public` — static assets served from Vercel's CDN.
- `api/index.ts` is auto-detected as a serverless function (`@vercel/node@5.10.2`),
  `maxDuration: 60s`, `memory: 1024MB` (headroom for PDF/XLSX work).
- Rewrites: `/api/*` → the function; everything else → `index.html` (SPA fallback).

## Required environment variables (Vercel Project → Settings → Environment Variables)

Set these for the **Production** (and Preview) environments:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes, to enable user creation** | Flips `adminReady=true`; unlocks self-service account creation and privileged writes. This is a **secret** — store encrypted, never commit. |
| `RESEND_API_KEY` | Yes, for real email | Sends notifications via Resend. Without it, email is disabled. |
| `EMAIL_FROM` | Recommended | Verified sender, e.g. `DFS Ops <noreply@yourdomain.com>`. Defaults to Resend's sandbox sender, which only delivers to your own verified address. |
| `SUPABASE_URL` | Optional | Ignored unless it points at a real `*.supabase.co` host. The correct project URL is baked in as a safe fallback. |
| `SUPABASE_ANON_KEY` | Optional | Public RLS-safe key; a valid fallback is baked in. |
| `NODE_ENV` | Auto | Vercel sets `production`. |

Notes:
- The anon key and project URL are public and safely baked in, so the app boots
  even if these env vars are unset.
- The `undici` direct-fetch and "ignore injected SUPABASE_URL" logic in
  `server/supabase.ts` are harmless on Vercel (there is no credential proxy);
  they simply pass through.

## After deploy — smoke tests

Run the automated smoke test against the deployment URL (works on any target —
Vercel preview/production, pplx.app, or local):

```bash
node script/smoke-test.mjs https://<your-vercel-preview>.vercel.app
```

It checks: health + adminReady, the JSON-404 API guard, auth (good/bad login,
unauthenticated rejection, token verification), authenticated reads, role-based
area scoping (admin vs area/super vs field), active-job detail, and the
cross-area asset guard. Exit code 0 = all passed, 1 = failures. It rolls back
any data it touches. Credentials default to the demo accounts; override with
`ADMIN_EMAIL/ADMIN_PW`, `AREA_EMAIL/AREA_PW`, `FIELD_EMAIL/FIELD_PW` env vars.

Still verify manually (not covered by the script):

1. Create a real user end-to-end (auth user + profile + notification prefs), log
   in as them, then delete — verifying rollback if the profile insert fails.
   (Requires `adminReady: true`, i.e. the service-role key set.)
2. Trigger a notification email and confirm delivery from the verified sender.
3. Confirm PDF export and Excel ingestion complete within the function limits.
4. Check cold-start latency on the first request after idle.

## Once live on Vercel

With steady daily traffic the Supabase idle-pause keep-alive check becomes
redundant — retire it after the transition so it isn't running unnecessarily.
