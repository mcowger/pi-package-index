# Pi Package Index — Implementation Plan

A Bun/TypeScript CLI tool that monitors npm for packages tagged with the keyword `pi-package`, fetches each package’s README, summarizes it with an LLM, and produces a static, searchable card-based index page deployable to GitHub Pages.

## Goals

1. **Search npm** for packages matching `keywords:pi-package` via the npm registry search API.
2. **Deduplicate** by package name so each package is stored and rendered exactly once.
3. **Fetch READMEs** from the npm packument (or GitHub fallback) and summarize them with an LLM.
4. **Write a single `packages.json`** containing all fetched package metadata, READMEs, and summaries.
5. **Generate a single `index.html`** that loads `packages.json`, renders responsive cards, and provides live inline substring search.
6. **Support daemon mode** with cron scheduling, automatic git commit/push, and GitHub Pages deployment.
7. **Be entirely static** — no server required; works on GitHub Pages.

---

## Architecture

Inspired by `../gha/` (github-awesome-monitor), the pipeline is split into two phases:

```
npm Registry Search  →  Package Metadata + README  →  LLM Summary
                                                            ↓
                                               packages.json
                                                            ↓
                                                   index.html
```

### Two-Phase Pipeline

| Phase | Command | What it does |
|---|---|---|
| **fetch** | `bun run start fetch` | Queries npm registry, fetches packuments/READMEs, runs LLM summarization, writes `packages.json`. |
| **render** | `bun run start render` | Reads `packages.json` and regenerates `index.html`. No API calls. |
| **run** | `bun run start` | fetch + render + git push (one-shot). |
| **daemon** | `bun run start daemon` | Runs on `CRON_SCHEDULE`, executing fetch → render → push each cycle. |

Separating fetch and render lets us iterate on HTML/CSS without re-burning API calls or LLM tokens.

---

## npm Registry Search

### API Endpoint

```
GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=0
```

- **Query parameter:** `text=keywords:pi-package` (the `keywords:` qualifier maps to package keywords).
- **Pagination:** `size` (max 250) and `from` (offset). We loop with `from+=size` until `total <= from`.
- **Response shape:**
  ```json
  {
    "objects": [
      {
        "package": {
          "name": "...",
          "description": "...",
          "version": "...",
          "keywords": ["..."],
          "date": "...",
          "links": { "npm": "...", "homepage": "...", "repository": "...", "bugs": "..." },
          "publisher": { "username": "..." },
          "maintainers": [...]
        },
        "score": { "final": 0.5, "detail": { "quality": 0.9, "popularity": 0.3, "maintenance": 0.7 } },
        "searchScore": 0.001
      }
    ],
    "total": 42
  }
  ```

### query-registry

We will use the [`query-registry`](https://www.npmjs.com/package/query-registry) package (v4.3.0+, TypeScript-native) to wrap the registry API. Relevant exports:

- `searchPackages({ query: 'keywords:pi-package', size: 250, from: 0 })`
- `getPackument(name)` — returns full packument including `readme`, `versions`, `dist-tags`, `time`
- `getPackageManifest(name, 'latest')` — leaner; returns the latest `package.json` plus registry metadata

Using `query-registry` gives us typed responses and automatic JSON parsing.

### Rate Limiting

The npm registry does not publish strict rate limits for read endpoints, but we will be respectful:
- 500 ms delay between search pagination requests.
- 300 ms delay between packument fetches.
- Sequential packument fetching (concurrency 3 via `p-limit`) to avoid hammering the registry.

---

## Data Model

### `packages.json` (`output/packages.json`)

A single file containing everything the UI needs:

```typescript
interface PackagesJson {
  generatedAt: string;          // ISO timestamp
  query: string;                // e.g. "keywords:pi-package"
  total: number;                // number of packages
  packages: Array<{
    name: string;               // npm package name
    version: string;            // latest version
    description: string | null;
    keywords: string[];
    date: string;               // last publish date (ISO)
    publisher: string | null;
    links: {
      npm: string;
      homepage: string | null;
      repository: string | null;
      bugs: string | null;
    };
    readme: string | null;      // raw README markdown/text
    readmeSource: 'npm' | 'github' | null;
    summary: string | null;     // LLM-generated prose summary
    stars: number | null;       // GitHub stars (if repo link resolved)
    error?: string;
    fetchedAt: string;
  }>;
}
```

The HTML page fetches this one file via `fetch('packages.json')` and holds the entire dataset in memory for instant search.

### State File (`state/reviewed.json`)

Tracks which packages have already been processed so we skip unnecessary LLM calls on subsequent runs:

```typescript
interface StateFile {
  packages: Array<{
    name: string;
    version: string;   // version at time of processing
    fetchedAt: string;
  }>;
}
```

On each fetch:
1. Search npm for all matching packages.
2. Filter out packages already in state **at the same version**.
3. For new/changed packages: fetch packument/README, summarize.
4. Merge new data with existing packages (by name), write `packages.json`.
5. Update state.

---

## Deduplication Strategy

Deduplication happens at **two levels**:

1. **Search-level dedup:** The npm search API may return the same package across paginated requests (rare but possible with registry replication lag). We collect all search results into a `Map<string, SearchResult>` keyed by `package.name` before moving to fetch.

2. **State-level dedup:** Before fetching a packument, check the state file. If the package name exists and the stored `version` matches the search result’s `latest` version, we skip fetching and keep the existing entry in `packages.json`. If the version changed, we re-fetch and re-summarize.

3. **Merge dedup:** When assembling `packages.json`, packages are stored in a `Map<string, Package>` keyed by name. Existing entries are overwritten only if the version changed or the package was explicitly re-fetched.

---

## README Retrieval

### Primary: npm Packument

`getPackument(name)` returns the full packument. The top-level `readme` field contains the README text for the latest version (rendered by the registry from the tarball). This is the fastest path — no GitHub API token required.

### Fallback: GitHub Repository

If the packument has no `readme` (uncommon but happens), or if it is very short (<200 chars), we fall back to the GitHub repository linked in `package.links.repository` or `package.repository.url`.

- Parse GitHub `owner/repo` from the repository URL.
- Use `@octokit/rest` (optional `GH_TOKEN`) to fetch the repo’s default README via `repos.getReadme({ owner, repo })`.
- Rate-limit and retry logic identical to `../gha/` (retry 429s, fail fast on 403s, 500ms/300ms delays).

---

## LLM Summarization

Identical approach to `../gha/`:

- **Library:** `multi-llm-ts` (OpenAI-compatible provider).
- **Prompt:** System prompt instructs a concise 3–4 sentence prose summary covering: (1) what the package does, (2) key features, (3) who would benefit.
- **Truncation:** READMEs > 4,000 chars are truncated before sending.
- **Concurrency:** `LLM_CONCURRENCY` (default 3) via `p-limit`.
- **Environment:** `LLM_API_KEY`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`.

If summarization fails, `summary` is `null` and the UI falls back to `description`.

---

## HTML / CSS / JS — The Index Page

### Self-Contained Static Page

`output/index.html` is a single file that:
1. Loads `packages.json` via `fetch()`.
2. Renders a responsive grid of cards.
3. Provides a search input that filters cards by substring match on name, description, keywords, publisher, and summary.

### Search Implementation (Client-Side)

- A `<input type="search">` debounced at 150 ms.
- On input, filter the packages array:
  ```js
  const term = input.value.toLowerCase();
  const filtered = packages.filter(p =>
    p.name.toLowerCase().includes(term) ||
    (p.description || '').toLowerCase().includes(term) ||
    (p.summary || '').toLowerCase().includes(term) ||
    p.keywords.some(k => k.toLowerCase().includes(term)) ||
    (p.publisher || '').toLowerCase().includes(term)
  );
  ```
- Re-render the card grid with the filtered set.
- If search is cleared, restore full grid.
- Display a result count (e.g. "12 of 42 packages").

### Card Design

Each card displays:
- **Package name** (linked to `links.npm`)
- **Version badge**
- **Publisher** (if available)
- **Star count** (if GitHub stars fetched)
- **Keywords** as small tags
- **AI summary** (or description fallback), clamped to 3 lines with a "Show more" toggle (same technique as `../gha/`)
- **Last updated** date

### Styling

- Dark theme matching `../gha/` (GitHub-like `#0d1117` background, `#c9d1d9` text).
- Responsive grid: 1 column (mobile) → 2 columns (tablet) → 3 columns (desktop).
- No external CSS frameworks; pure inline styles + CSS classes in a `<style>` block, so it works offline and on GitHub Pages without bundlers.
- Google Fonts (Inter) from CDN for polish.

### Lazy README Expansion

Because all data lives in the single `packages.json`, each card can optionally show the full raw README when expanded without additional network requests.

---

## Module Structure

```
src/
├── index.ts       # CLI entry point — commands: fetch, render, run, daemon
├── npm.ts         # query-registry wrapper — search, packument, merge logic
├── parser.ts      # Extract GitHub owner/repo from repository URLs (for README fallback)
├── github.ts      # Octokit README fallback (reused from ../gha/ with minor tweaks)
├── llm.ts         # multi-llm-ts summarization (reused from ../gha/)
├── html.ts        # index.html generator (packages.json → static HTML + inline JS)
├── render.ts      # Read packages.json, invoke html.ts, write index.html
├── state.ts       # JSON state file read/write (reviewed packages)
├── types.ts       # Shared TypeScript interfaces
└── dashboard.ts   # Optional: ANSI live dashboard (ported from ../gha/)
```

---

## GitHub Pages Deployment

Same pattern as `../gha/`:

1. `.github/workflows/deploy.yml` triggers on `push` to `main` when `output/**` changes, or manually.
2. Uses `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`.
3. The `output/` directory is **not gitignored**; it is committed by the CLI after each run.

### Git Integration in CLI

- `gitInitOrPull()` — clones or pulls the repo into `GIT_REPO_DIR` (default `/repo`).
- `gitCommitAndPush()` — stages `output/`, commits only if content changed, pushes.
- Authenticated via `GH_TOKEN` embedded in the HTTPS URL.

---

## Daemon Mode

Identical to `../gha/`:

- `CRON_SCHEDULE` env var (e.g. `"0 */6 * * *"`).
- `getNextCronDelay()` parses the cron expression and schedules the next run.
- Runs `runOnce()` immediately on startup, then sleeps until the next scheduled time.
- Handles `SIGTERM` / `SIGINT` gracefully.
- Suitable for Docker (`docker run -d … daemon`).

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_API_KEY` | **Yes** | — | API key for LLM provider |
| `LLM_PROVIDER` | No | `openai` | multi-llm-ts provider ID |
| `LLM_BASE_URL` | No | — | Custom base URL for LLM API |
| `LLM_MODEL` | No | — | Model name |
| `GH_TOKEN` | No | — | GitHub PAT (for README fallback + git push) |
| `OUTPUT_DIR` | No | `./output` | Directory for JSON + HTML output |
| `STATE_FILE` | No | `./state/reviewed.json` | State file path |
| `CRON_SCHEDULE` | No | — | Cron expression for daemon mode |
| `GIT_REPO_URL` | No | `https://github.com/…` | Repo to clone/push |
| `GIT_REPO_DIR` | No | `/repo` | Local clone path |
| `FETCH_CONCURRENCY` | No | `3` | Max parallel npm packument fetches |
| `LLM_CONCURRENCY` | No | `3` | Max parallel LLM calls |

---

## Development Milestones

1. **Bootstrap** — `package.json`, `tsconfig.json`, dependencies (`query-registry`, `multi-llm-ts`, `p-limit`, `dotenv`, `@octokit/rest`, `isomorphic-git`).
2. **Search + Fetch** — Implement `src/npm.ts` to search by keyword, iterate pages, fetch packuments, extract READMEs.
3. **Deduplication + State** — Implement `src/state.ts` and integrate version-based skip logic.
4. **LLM Pipeline** — Reuse/adapt `src/llm.ts` from `../gha/`.
5. **JSON Output** — Merge all data into a single `packages.json`.
6. **HTML Render** — Build `src/html.ts` with card grid + inline search. No framework — vanilla JS.
7. **CLI + Commands** — Wire up `fetch`, `render`, `run`, `daemon` in `src/index.ts`.
8. **Git + Pages** — Add `gitInitOrPull`, `gitCommitAndPush`, and `.github/workflows/deploy.yml`.
9. **Polish** — Dashboard, error handling, README fallback, responsive design.
10. **Deploy** — Run locally to populate `output/`, push, enable Pages.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| npm registry rate limits | Low concurrency (3), 300–500 ms delays between requests. No auth required for reads. |
| Large number of packages (>250) | The search API max is 250. If we exceed this, we can add scoped or author-based sub-searches and merge results. |
| README missing from packument | GitHub fallback via `@octokit/rest`. |
| LLM costs/tokens | State file skips unchanged packages. Summaries are cached in JSON and never re-fetched unless version changes. |
| GitHub Pages 1 GB limit | A single `packages.json` + one HTML is tiny. Even 1,000 packages is likely <10 MB. |

---

## References

- `../gha/` — Reference architecture (fetch/render split, daemon, git push, HTML generation).
- [npm Registry API Docs](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) — Search endpoint spec (`/-/v1/search`).
- [query-registry on npm](https://www.npmjs.com/package/query-registry) — Typed registry API wrapper.
- [multi-llm-ts](https://github.com/nbonamy/multi-llm-ts) — LLM abstraction used in `../gha/`.
