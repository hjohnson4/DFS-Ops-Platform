# Updating DFS Ops after it's on Vercel

Once the repo is connected to Vercel, you never manually upload again. The
workflow is: **change code → commit → push**. Vercel rebuilds and redeploys
automatically.

## The everyday loop

```bash
# 1. Make your code changes (or have them made in the Perplexity workspace)

# 2. See what changed
git status

# 3. Stage and commit
git add -A
git commit -m "Describe the change"

# 4. Push — this triggers the deploy
git push
```

Within ~1–2 minutes Vercel runs `npm run build:vercel`, redeploys the API
function + static frontend, and swaps production over atomically. Users never
see a half-deployed state.

## Test before it goes live (recommended)

Don't push straight to `main` for anything risky. Use a branch:

```bash
git checkout -b my-change      # start a branch
# ...edit, commit...
git push -u origin my-change   # Vercel builds a PREVIEW deploy with its own URL
```

Open the preview URL Vercel gives you, verify the change on a real deployment,
then merge the branch into `main` (via a GitHub pull request or `git merge`) to
promote it to production.

## If an update breaks production

Every deploy is kept. In the Vercel dashboard → Deployments, find the last good
one and click **Promote to Production** (or "Rollback"). You're back to the
working version in seconds — no rebuild. Then fix the code and push again.

## Environment variables / secrets

Secrets live in the Vercel dashboard (Settings → Environment Variables), NOT in
the code. They persist across every deploy — updating code never touches them.
If you change a variable, Vercel prompts you to redeploy for it to take effect.
Local dev reads them from `.env` (see `.env.example`); `.env` is gitignored.

## The two deploy targets (don't confuse them)

| Command | Target | When |
| --- | --- | --- |
| `git push` | **Vercel** (production) | The real app, after cutover |
| `npm run build` + pplx publish | pplx.app | The existing fallback deployment |

`server/index.ts` powers pplx.app/standalone; `api/index.ts` powers Vercel.
Both share `server/app.ts`, so a code change to routes/logic applies to both —
you just deploy it through whichever path you're using. See `VERCEL_DEPLOY.md`
for the full Vercel setup and env-var reference.

## One-time: create the repo and connect Vercel

```bash
# From the project root, after `git init` and the first commit:
# 1. Create an empty repo on github.com (no README/gitignore — we have them).
# 2. Point this repo at it and push:
git remote add origin https://github.com/<you>/dfs-ops.git
git branch -M main
git push -u origin main

# 3. On vercel.com → Add New Project → Import the GitHub repo.
#    Framework preset: Other. Build settings come from vercel.json.
#    Add the environment variables from .env.example (with real values).
#    Deploy.
```

After that, every `git push` deploys automatically.
