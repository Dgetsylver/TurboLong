# PR Preview Deploys

Every pull request automatically deploys both `frontend` and `landing` to
Cloudflare Pages. The platform bot posts a comment with the preview URLs as
soon as each deploy finishes.

## How it works

`.github/workflows/preview.yml` runs on every PR:

1. Builds `frontend/` with Vite (same as production).
2. Deploys `frontend/dist` and `landing/` to their respective Cloudflare Pages
   projects on a branch named `pr-<number>`.
3. Posts (or updates) a comment on the PR with the preview URL.

## Required secrets

Add these in **Settings → Secrets and variables → Actions** of the repository:

| Secret | Where to get it |
|---|---|
| `CF_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template (scope: Pages) |
| `CF_ACCOUNT_ID` | Cloudflare dashboard → right sidebar on any zone page, or `https://dash.cloudflare.com/<account-id>` |

The token needs the **Cloudflare Pages: Edit** permission for both projects.

## Cloudflare Pages projects

Create two projects once (they can be empty — the workflow pushes to them):

```
npx wrangler pages project create turbolong-frontend
npx wrangler pages project create turbolong-landing
```

Or create them via the Cloudflare dashboard (Workers & Pages → Create → Pages).

## Preview URL format

```
https://pr-<number>.<project>.pages.dev
```

Previews are retained by Cloudflare for 30 days after the branch is deleted.
