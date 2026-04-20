# Pi Package Index

A Bun/TypeScript CLI tool that monitors npm for packages tagged with `pi-package`, fetches each package's README, summarizes it with an LLM, and produces a static, searchable card-based index page deployable to GitHub Pages.

## Running

```bash
bun install
bun run start          # fetch + render + git push (one-shot)
bun run start fetch    # fetch only (npm API + LLM)
bun run start render   # render existing packages.json → HTML
bun run start daemon   # run on CRON_SCHEDULE, fetch + render + push each cycle
```

Requires a `.env` file — copy from `.env.example` and fill in credentials. The only strictly required variable is `LLM_API_KEY`. A `GH_TOKEN` is recommended for GitHub README fallback and higher API rate limits.

## Architecture

The pipeline has two phases, split by subcommand:

1. **`fetch`** — Searches npm registry for `keywords:pi-package`, fetches packuments/READMEs, runs LLM summarization, and writes a single `packages.json` to the output directory.
2. **`render`** — Reads `packages.json` and renders `index.html`. No API calls or LLM usage — can be re-run freely to tweak the HTML template.
3. **(default)** — Running with no subcommand runs both phases sequentially.

### Data Flow

```
npm Registry Search → Package Metadata + README → LLM Summary
                                         ↓
                                   packages.json
                                         ↓
                                     index.html
```

### Deduplication

- **Search-level**: npm results are deduplicated by package name across paginated requests.
- **State-level**: A JSON state file (`state/reviewed.json`) tracks each package's last-processed version. Unchanged packages are skipped on subsequent runs, avoiding unnecessary API calls and LLM tokens.
- **Merge-level**: When writing `packages.json`, existing entries are preserved unless the version changed.

## npm Registry Search

Uses the [`query-registry`](https://www.npmjs.com/package/query-registry) package to query the npm registry search endpoint:

```
GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=0
```

The endpoint supports pagination (`size` max 250, `from` offset). The tool loops through all pages until the full result set is collected.

## README Retrieval

1. **Primary**: Fetch the packument via `getPackument(name)` and read the top-level `readme` field.
2. **Fallback**: If the packument has no README (or it's <200 chars), parse the repository URL and fetch the README via the GitHub API (`repos.getReadme`).

## LLM Summarization

Uses `multi-llm-ts` with an OpenAI-compatible provider. Configured via:
- `LLM_PROVIDER` (default: `openai`)
- `LLM_BASE_URL` (optional)
- `LLM_API_KEY` (required)
- `LLM_MODEL` (optional, auto-selected if omitted)

READMEs are truncated to 4,000 chars before sending. The prompt asks for a concise 3–4 sentence prose summary.

## HTML / Search

`output/index.html` is a single self-contained file that:
1. Loads `packages.json` via `fetch()`
2. Renders a responsive card grid
3. Provides live inline substring search across name, description, keywords, publisher, and summary

Search is debounced at 150ms and runs entirely client-side.

## GitHub Pages Deployment

The `.github/workflows/deploy.yml` workflow triggers on `push` to `main` when `output/**` changes, or manually. It uploads the `output/` directory to GitHub Pages.

### Git Integration

When `GIT_REPO_URL` is set, the CLI:
1. Clones or pulls the repo into `GIT_REPO_DIR`
2. Runs fetch + render
3. Commits and pushes `output/` changes

Authentication uses `GH_TOKEN` embedded in the HTTPS URL.

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
| `GIT_REPO_URL` | No | — | Repo to clone/push |
| `GIT_REPO_DIR` | No | `/repo` | Local clone path |
| `FETCH_CONCURRENCY` | No | `3` | Max parallel npm packument fetches |
| `LLM_CONCURRENCY` | No | `3` | Max parallel LLM calls |

## Development

```bash
# Test npm search
bun -e "import { searchNpmPackages } from './src/npm.js'; const r = await searchNpmPackages(); console.log(r.size, 'packages');"

# Test render without fetching
bun run start render
```

To modify the HTML design, edit `src/html.ts` and run `bun run start render` — no API calls needed.
