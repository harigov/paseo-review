# PR Review for Paseo

A [Paseo](https://paseo.sh) plugin for reviewing large GitHub pull requests.

- **Inbox** for every github.com repo you've added to Paseo: My PRs, Review requested, Assigned
  and All open, with search, filters and sorting.
- **Modules.** Each PR is split into Data model, API, Core, UI, Tests, Infra, Docs and **Noise**,
  using git facts, path rules and an optional decision model. Each module is its own tab with
  risk, complexity and viewed progress.
- **Reading order:** foundations first (definitions before use), riskiest first, or
  chronological.
- **Diff viewer:** fast scrolling on huge files, moved-code detection, whitespace-only and
  pure-move collapse, syntax highlighting, inline threads and validator findings.
- **Viewed state synced with GitHub's "Viewed" checkbox.** A file that changed after you viewed
  it shows only what changed since then, labelled substantive or trivial.
- **Since my last review:** filters to files changed since your last submitted review and
  hides rebase-only changes.
- **Validators.** Short markdown checks evaluated by a System One decision model (OpenRouter Jev
  by default; Cloudflare Clef, TypeSafe Jev or any compatible endpoint). Results are fast, cheap and calibrated, with
  pass/fail per hunk.
- **Chat with a PR** using your own Paseo agents (Claude Code, Codex, Cursor, OpenCode, or your
  agent profiles). It runs in a PR worktree with a read-only toolset.
- **Rich HTML PR descriptions** (`<!-- paseo:html -->` blocks) rendered in a sandbox, plus
  agent-generated visual overviews and descriptions. Blocks must be self-contained (inline
  SVG/CSS/JS, no injected libraries); Mermaid in the normal markdown body still renders on
  github.com.
- **Precompute** analyses PRs that need your review in the background.

## Requirements

- Paseo **0.10.2 or newer**. On 0.11+ the plugin uses the new screen API automatically.
- `gh` installed and logged in on the daemon host (`gh auth status`).
- Optional: an OpenRouter API key (default), a Cloudflare account (Workers AI) or a TypeSafe
  API key, for decisions and validators.

## Install

```bash
# 1. Put the plugin somewhere stable and install its dependencies
git clone <this repo> ~/paseo-plugins/pr-review
cd ~/paseo-plugins/pr-review
npm install

# 2. Enable plugins on the daemon (Settings → Plugins → Enable plugins), or:
#    set "pluginsEnabled": true in ~/.paseo/config.json and run `paseo reload`

# 3. Install and check
paseo plugin install ~/paseo-plugins/pr-review
paseo plugin ls
paseo plugin logs pr-review
```

Plugins are trusted, unsandboxed code. The server half runs on the daemon host with your user's
access (including `gh` and git).

After editing the source, run `npm run typecheck && npm run check:bundle` and then
`paseo plugin reload pr-review`.

## Configure (Settings → Plugins → PR Review)

**Decision model (validators, module assignment, risk, thread triage)**

The default is **OpenRouter**'s System One API (`https://openrouter.ai/api/v1/systemone`) with
model `typesafe/jev-1.13`. Paste your OpenRouter API key into **API key**, or export it on the
daemon host and restart the daemon:

```bash
export OPENROUTER_API_KEY=…
```

Other providers:
- **Cloudflare Workers AI:** provider `cloudflare`, model `clef-flash`, account ID plus
  `CLOUDFLARE_API_TOKEN`.
- **TypeSafe Jev:** provider `jev`, model `jev-latest`, `TYPESAFE_API_KEY`.
- **Self-hosted or any System One-compatible API:** set **Endpoint URL**. It overrides the URL
  for every provider, so you can also point it at a Cloudflare AI Gateway.

**Privacy.** Code is sent to the decision API only for repos you opt in to — enforced in the
analysis pipeline, the validators "Test on this PR" action, and the `/validate` command (which
resolves your workspace to its registered repo and refuses to run if that repo isn't opted in).
The setting is off by default. For an opted-in repo, what's sent is diff hunks/file diffs and
the PR title/body, for validators, module/risk/complexity classification and severity. The
inbox's attention ranking sends PR metadata only (title, author, size, checks, review decision,
draft state, age — no code), and only for opted-in repos. Repos that aren't opted in still get
git and path heuristics, with no code leaving the machine.

**Agents.** Pick an agent per task: summary, chat, explain, visual or describe. The choices come
from your Paseo agent profiles and available providers.

**Precompute.** Interval, daily agent budget, skip drafts and size cap.

## Repo configuration (optional)

`.paseo/review.yml` overrides the modules and file rules:

```yaml
modules:
  - { id: billing, title: Billing, description: Payment and invoicing code }
rules:
  - { glob: "services/billing/**", module: billing }
  - { glob: "**/*.generated.ts", module: noise }
```

`.paseo/validators/*.md` holds validators that are shared and reviewed like code:

```md
---
title: Authorization is enforced on endpoints
severity: blocking          # blocking | warning | info
unit: hunk                  # hunk | file | pr
threshold: 0.8
violation: A new or changed handler reads or writes data without an authorization check
compliant: The handler checks the caller's permission, or delegates to middleware that does
not_applicable: The change does not add or modify a request handler
---
Does this change let a caller act on data without an authorization check?
```

Personal validators live in `~/.paseo/plugin-data/pr-review/validators/`. Write each one as a
direct, single-property question; decision models are weak at multi-hop reasoning, counting and
dates.

**Guidance files.** `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` are passed to every agent (chat,
summaries, explanations).

## Rich HTML descriptions

Add a hidden block to the PR body. GitHub keeps it but doesn't render it, while PR Review renders
it in a sandboxed frame on desktop and web. Inline scripts and styles are allowed; network access
is blocked. There's no library injection (Mermaid, chart libraries, etc.) — the block must be
fully self-contained. A Mermaid code fence in the normal markdown part of the body is unaffected
and still renders natively on github.com.

```md
Normal markdown that GitHub shows…

<!-- paseo:html -->
<html><body><svg>…diagram…</svg></body></html>
<!-- /paseo:html -->
```

## Development

```bash
npm run typecheck      # tsc against the Paseo 0.10.2 SDK typings
npm run check:bundle   # esbuild bundle check mirroring Paseo's plugin compiler
npm test               # vitest
```

See [docs/plan.md](docs/plan.md) for the design and [THIRD_PARTY.md](THIRD_PARTY.md) for
attributions.
