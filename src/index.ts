import 'dotenv/config';
import pLimit from 'p-limit';
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';

import { loadState, saveState, isReviewed, markReviewed } from './state.js';
import { searchNpmPackages, fetchPackageData, SEARCH_QUERY } from './npm.js';
import type { SearchResults } from 'query-registry';
import { summarizeReadme } from './llm.js';
import { renderIndex } from './render.js';
import { githubLimit } from './github.js';
import { ProgressiveSaver } from './progressive.js';
import {
  initDashboard, stopDashboard,
  setPackageTotal, incPackagesDone, incLlmDone,
  setCurrentPackage, addCurrentLlm, removeCurrentLlm,
  logLine,
} from './dashboard.js';
import type { PackageData, PackagesJson } from './types.js';

// ── Configuration ──────────────────────────────────────────
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const STATE_FILE = process.env.STATE_FILE || './state/reviewed.json';
const FETCH_CONCURRENCY = parseInt(process.env.FETCH_CONCURRENCY || '3', 10);
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '';
const GIT_REPO_URL = process.env.GIT_REPO_URL || '';
const GIT_REPO_DIR = process.env.GIT_REPO_DIR || '/repo';
const FETCH_DELAY_MS = 300;

function validateEnv(): void {
  const required = ['LLM_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Concurrency limiters ───────────────────────────────────
const fetchLimit = pLimit({ concurrency: FETCH_CONCURRENCY });
const llmLimit = pLimit({ concurrency: LLM_CONCURRENCY });

// ── Git helpers ─────────────────────────────────────────────

async function gitInitOrPull(): Promise<void> {
  if (!GIT_REPO_URL) {
    console.log('  ⚠️  No GIT_REPO_URL set, skipping git operations');
    return;
  }

  const dir = GIT_REPO_DIR;
  const token = process.env.GH_TOKEN;
  const auth = { username: 'pi-bot', password: token };
  const http = await import('isomorphic-git/http/node').then(m => m.default);
  const url = token
    ? GIT_REPO_URL.replace('https://', `https://pi-bot:${token}@`)
    : GIT_REPO_URL;

  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log(`📋 Cloning ${GIT_REPO_URL} → ${dir}...`);
    await git.clone({ fs, http, dir, url, onAuth: () => auth, singleBranch: true, depth: 50 });
    console.log('  ✅ Repo cloned');
  } else {
    try {
      const branch = (await git.currentBranch({ fs, dir })) || 'main';
      const remote = (await git.listRemotes({ fs, dir }))[0]?.remote || 'origin';
      await git.pull({ fs, http, dir, remote, ref: branch, url, onAuth: () => auth, singleBranch: true });
      console.log('  ✅ Repo pulled');
    } catch {
      console.log('  ⚠️  Pull failed (may be ahead of remote)');
    }
  }

  process.chdir(dir);
}

async function gitCommitAndPush(message: string): Promise<void> {
  if (!GIT_REPO_URL) return;

  try {
    const dir = process.cwd();
    const token = process.env.GH_TOKEN;
    const remote = (await git.listRemotes({ fs, dir }))[0]?.remote || 'origin';
    const branch = (await git.currentBranch({ fs, dir })) || 'main';
    const repoUrl = token
      ? GIT_REPO_URL.replace('https://', `https://pi-bot:${token}@`)
      : GIT_REPO_URL;

    const auth = { username: 'pi-bot', password: token };
    const http = await import('isomorphic-git/http/node').then(m => m.default);

    const pattern = 'output/';
    const matrix = await git.statusMatrix({ fs, dir, filter: (f: string) => f.startsWith(pattern) });

    const changed = matrix.filter((row: Array<string | number>) => {
      return row[0] === 0 && row[1] === 0
        || row[1] !== row[2];
    });

    if (changed.length === 0) {
      console.log('  📭 No changes to commit');
      return;
    }

    for (const [filepath] of changed) {
      await git.add({ fs, dir, filepath });
    }

    let hasRealChanges = false;
    for (const [filepath, headSha] of changed) {
      if (headSha === 0) {
        hasRealChanges = true;
        break;
      }
      try {
        const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const headBlob = await git.readBlob({ fs, dir, oid: headOid, filepath: String(filepath) });
        const headContent = Buffer.from(headBlob.blob).toString('utf-8');
        const workContent = fs.readFileSync(path.join(dir, String(filepath)), 'utf-8');
        if (headContent !== workContent) {
          hasRealChanges = true;
          break;
        }
      } catch {
        hasRealChanges = true;
        break;
      }
    }

    if (!hasRealChanges) {
      console.log('  📭 No content changes to commit');
      try { await git.resetIndex({ fs, dir, filepath: '.' }); } catch { /* ok */ }
      return;
    }

    await git.commit({ fs, dir, message, author: { name: 'pi-bot', email: 'bot@pi.local' } });
    await git.push({ fs, http, dir, remote, ref: branch, url: repoUrl, onAuth: () => auth, force: true });

    console.log(`  📤 Pushed: ${message}`);
  } catch (err) {
    console.error(`  ❌ Git push failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Core pipeline ───────────────────────────────────────────

async function fetch(): Promise<void> {
  validateEnv();

  const state = loadState(STATE_FILE);

  console.log('🔍 Searching npm registry...\n');
  const searchResults = await searchNpmPackages();

  // Determine which packages need fetching
  const skipNames = new Set<string>();
  for (const [name, obj] of searchResults) {
    if (isReviewed(state, name, obj.package.version)) {
      skipNames.add(name);
    }
  }

  const toFetch: Array<SearchResults['objects'][number]> = [];
  for (const [name, obj] of searchResults) {
    if (!skipNames.has(name)) {
      toFetch.push(obj);
    }
  }

  if (toFetch.length === 0 && searchResults.size === 0) {
    console.log('✅ No packages found.');
    return;
  }

  if (toFetch.length === 0) {
    console.log(`\n✅ All ${skipNames.size} package(s) up to date.`);
    return;
  }

  console.log(`\n📦 Fetching + summarizing ${toFetch.length} package(s)...\n`);

  // Progressive saver: writes packages.json every N completions + on timer
  const saver = new ProgressiveSaver(OUTPUT_DIR, SEARCH_QUERY, 10, 10_000);
  saver.seed(readExistingPackages());
  saver.start();

  // Ensure we flush on interrupt
  const flushOnExit = (): void => {
    console.log('\n💾 Flushing progress...');
    saver.stop();
    saveState(STATE_FILE, state);
    process.exit(0);
  };
  process.once('SIGINT', flushOnExit);
  process.once('SIGTERM', flushOnExit);

  initDashboard(fetchLimit, llmLimit, githubLimit);
  setPackageTotal(toFetch.length);

  // For each package: fetch (limited) → summarize (limited) → save progressively
  const workPromises = toFetch.map((obj) =>
    (async () => {
      // ── Fetch phase ──
      let pkg = await fetchLimit(async () => {
        setCurrentPackage(obj.package.name);
        await sleep(FETCH_DELAY_MS);
        try {
          return await fetchPackageData(obj);
        } catch (err: any) {
          console.error(`  ❌ Failed to fetch ${obj.package.name}: ${err.message}`);
          return {
            name: obj.package.name,
            version: obj.package.version,
            description: obj.package.description || null,
            keywords: obj.package.keywords || [],
            date: obj.package.date,
            publisher: obj.package.publisher?.username || null,
            links: {
              npm: obj.package.links?.npm || `https://www.npmjs.com/package/${obj.package.name}`,
              homepage: obj.package.links?.homepage || null,
              repository: obj.package.links?.repository || null,
              bugs: obj.package.links?.bugs || null,
            },
            readme: null,
            readmeSource: null,
            summary: null,
            stars: null,
            error: err.message,
            fetchedAt: new Date().toISOString(),
          } as PackageData;
        }
      });

      incPackagesDone();

      // ── Summarize phase (chains immediately after fetch) ──
      if (pkg.readme) {
        addCurrentLlm(pkg.name);
        const summary = await llmLimit(() => summarizeReadme(pkg.readme!, pkg.name));
        removeCurrentLlm(pkg.name);
        incLlmDone();

        if (summary) {
          logLine(`✅ Summarized ${pkg.name}`);
        } else {
          logLine(`⚠️  Summarization failed for ${pkg.name}`);
        }

        pkg = { ...pkg, summary };
      }

      // ── Progressive save ──
      saver.markComplete(pkg);

      // Update state (in-memory, flushed to disk periodically by caller)
      const updated = markReviewed(state, {
        name: pkg.name,
        version: pkg.version,
        fetchedAt: pkg.fetchedAt,
      });
      Object.assign(state, updated);

      return pkg;
    })(),
  );

  const results = await Promise.all(workPromises);

  stopDashboard();
  saver.stop();

  // Remove interrupt handlers so daemon mode can set its own
  process.off('SIGINT', flushOnExit);
  process.off('SIGTERM', flushOnExit);

  // Final state save
  saveState(STATE_FILE, state);

  // Failure summary
  const failures = results.filter((p) => p.error);
  if (failures.length > 0) {
    console.log(`\n📋 Failure Summary (${failures.length} package${failures.length === 1 ? '' : 's'}):`);
    for (const p of failures) {
      console.log(`  ❌ ${p.name} — ${p.error}`);
    }
    writeErrorsJson(failures, OUTPUT_DIR);
    console.log(`  📝 errors.json → ${path.join(OUTPUT_DIR, 'errors.json')}`);
  }

  console.log(`\n💾 packages.json → ${path.join(OUTPUT_DIR, 'packages.json')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeErrorsJson(failures: PackageData[], outputDir: string): void {
  const slim = failures.map((p) => ({
    name: p.name,
    version: p.version,
    error: p.error,
    fetchedAt: p.fetchedAt,
  }));
  const filepath = path.join(outputDir, 'errors.json');
  fs.writeFileSync(filepath, JSON.stringify({ count: slim.length, failures: slim }, null, 2), 'utf-8');
}

function readExistingPackages(): PackageData[] {
  try {
    const raw = fs.readFileSync(path.join(OUTPUT_DIR, 'packages.json'), 'utf-8');
    const data = JSON.parse(raw) as PackagesJson;
    return data.packages || [];
  } catch {
    return [];
  }
}

async function render(): Promise<void> {
  console.log('🎨 Pi Package Index — render\n');
  renderIndex(OUTPUT_DIR);
}

async function runOnce(): Promise<void> {
  console.log(`${'═'.repeat(50)}`);
  console.log(`  Pi Package Index — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}\n`);

  await gitInitOrPull();

  await fetch();
  console.log();
  await render();

  const dateStr = new Date().toISOString().slice(0, 10);
  await gitCommitAndPush(`📦 update packages ${dateStr}`);
}

function getNextCronDelay(expression: string): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: ${expression}`);

  const [minuteField, hourField] = parts;

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
    }
    return field.split(',').map(Number);
  };

  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let offset = 0; offset < 48; offset++) {
    const day = new Date(startOfToday);
    day.setDate(day.getDate() + offset);

    for (const h of hours) {
      for (const m of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0);
        if (candidate.getTime() > now.getTime()) {
          return candidate.getTime() - now.getTime();
        }
      }
    }
  }

  return 6 * 60 * 60 * 1000;
}

async function daemon(): Promise<void> {
  if (!CRON_SCHEDULE) {
    console.error('CRON_SCHEDULE is required for daemon mode. e.g. "0 */6 * * *"');
    process.exit(1);
  }

  console.log(`🕐 Daemon mode — schedule: ${CRON_SCHEDULE}\n`);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  const cleanup = (): void => {
    if (!running) return;
    running = false;
    if (timer) clearTimeout(timer);
    console.log('\n🛑 Shutting down...');
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  try {
    await runOnce();
  } catch (err) {
    console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!running) return;

  const scheduleNext = (): void => {
    if (!running) return;
    const delay = getNextCronDelay(CRON_SCHEDULE);
    const next = new Date(Date.now() + delay);
    console.log(`\n⏰ Next run at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)\n`);

    timer = setTimeout(async () => {
      if (!running) return;
      try {
        await runOnce();
      } catch (err) {
        console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

// ── CLI ─────────────────────────────────────────────────────
function printUsage(): void {
  console.log(`Usage: bun run src/index.ts <command>

Commands:
  fetch    Search npm and gather package data (writes packages.json)
  render   Render packages.json to index.html
  run      Fetch + render + git push (one-shot)
  daemon   Run on a CRON_SCHEDULE, fetch + render + push each cycle
  (none)   Same as 'run'

Environment variables:
  CRON_SCHEDULE        Cron expression for daemon mode (e.g. "0 */6 * * *")
  FETCH_CONCURRENCY    Max parallel npm packument fetches (default: 3)
  LLM_CONCURRENCY      Max parallel LLM calls (default: 3)
  NO_DASHBOARD         Set to 1 to force plain console logs instead of TUI`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'fetch':
      await fetch();
      break;
    case 'render':
      await render();
      break;
    case 'run':
      await runOnce();
      break;
    case 'daemon':
      await daemon();
      break;
    case undefined:
      await runOnce();
      break;
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      console.error(`Unknown command: "${command}"\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
