# CIS Org Chart

Interactive organization chart for **Tyler Romeo's Content & Industry Services** org. Auto-syncs from Tyler's source-of-truth Mermaid file.

🔗 **Live**: https://ebaezdel.github.io/cis-org-chart/

## How it works

```
┌─────────────────────┐         ┌──────────────────────┐         ┌──────────────────┐
│ Tyler's repo        │         │ This repo            │         │ GitHub Pages     │
│ org_chart_updated   │ ──────▶ │ scripts/parse-mmd.js │ ──────▶ │ index.html       │
│ .mmd                │ webhook │ → data.json          │  Pages  │ + data.json      │
└─────────────────────┘         └──────────────────────┘         └──────────────────┘
                                         ▲
                                         │ data.overlay.json
                                         │ (TechMod, etc.)
```

1. Tyler edits `org_chart_updated.mmd` in his repo
2. His repo fires a `repository_dispatch` webhook to this repo
3. The `sync-org` workflow fetches the .mmd, runs the parser, merges the overlay, and commits `data.json`
4. The `pages` workflow auto-deploys the static site

## Files

| File | Purpose |
|---|---|
| `index.html` | The interactive chart. Loads `data.json` at runtime. |
| `data.json` | Generated org tree. Don't edit by hand — regenerated on every sync. |
| `data.overlay.json` | Manual additions (e.g. TechMod cross-functional team) merged on top of Tyler's .mmd. |
| `scripts/parse-mmd.js` | Mermaid graph → JSON tree. Tier-aware (uses `style fill:#...` to classify nodes). |
| `scripts/test-fixture.mmd` | Bundled fixture used when no upstream is configured. |
| `.github/workflows/sync-org.yml` | Triggered by webhook / manual / parser changes. |
| `.github/workflows/pages.yml` | Deploys to GitHub Pages on every push to main. |

## Configuring the upstream sync

When you have access to Tyler's repo, set this **repository variable** in
**Settings → Secrets and variables → Actions → Variables**:

```
TYLER_REPO = <owner>/<repo>     # e.g. tylerromeo/org-charts
```

If the file lives in a private repo, also create a **fine-grained PAT** with read-only contents access to that repo and store it as a **secret** named `TYLER_REPO_TOKEN`. The workflow will use it for the fetch.

### Telling Tyler's repo to fire the webhook

Add a workflow on his side that runs on push to `org_chart_updated.mmd`:

```yaml
- run: |
    curl -X POST \
      -H "Authorization: Bearer ${{ secrets.CIS_ORG_CHART_TOKEN }}" \
      -H "Accept: application/vnd.github+json" \
      https://api.github.com/repos/ebaezdel/cis-org-chart/dispatches \
      -d '{"event_type":"org-chart-updated"}'
```

`CIS_ORG_CHART_TOKEN` on his side = a fine-grained PAT scoped to **this** repo (`ebaezdel/cis-org-chart`) with `contents: write` (needed to trigger `repository_dispatch`).

## Manual run

From the **Actions** tab → **Sync org chart from Tyler's .mmd** → **Run workflow**. Useful when:
- Tyler doesn't have the dispatch wired up yet
- You're testing parser changes against a different repo (use the `tyler_repo` input)

## Editing the overlay

`data.overlay.json` holds anything that isn't in Tyler's .mmd — currently just **TechMod**. Edit it, commit, and the next sync will include the change. If Tyler later adds TechMod to his .mmd with the same `id`, the overlay is silently skipped (Tyler wins).

## Local development

```bash
node scripts/parse-mmd.js scripts/test-fixture.mmd data.json
python3 -m http.server 8000
open http://localhost:8000
```
