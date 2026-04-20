/**
 * Live dashboard for Pi Package Index.
 * In a real terminal: uses an alternate screen buffer for a clean TUI.
 * In CI / non-TTY: falls back to plain console.log.
 */

import type pLimit from 'p-limit';

// ── ANSI helpers ────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

const CLEAR_SCREEN = '\x1b[2J';
const HOME = '\x1b[H';
const ALT_SCREEN = '\x1b[?1049h';
const MAIN_SCREEN = '\x1b[?1049l';

function out(s: string): void { process.stdout.write(s); }
const isTty = process.stdout.isTTY && !process.env.NO_DASHBOARD;

// ── Dashboard state ─────────────────────────────────────────
interface DashboardState {
  packagesDone: number;
  packagesTotal: number;
  llmDone: number;
  llmTotal: number;

  fetchLimiter: ReturnType<typeof pLimit>;
  llmLimiter: ReturnType<typeof pLimit>;
  githubLimiter: ReturnType<typeof pLimit>;

  currentPackage: string;
  currentLlm: string[];

  recentLines: string[];
}

const MAX_RECENT = 5;
let dashState: DashboardState | null = null;
let repaintTimer: ReturnType<typeof setInterval> | null = null;

function ensureState(): DashboardState {
  if (!dashState) throw new Error('Dashboard not initialized');
  return dashState;
}

// ── Drawing helpers ─────────────────────────────────────────

function progressBar(done: number, total: number, width: number = 20): string {
  if (total === 0) return `${GRAY}${'░'.repeat(width)}${RESET} 0/0`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `${GREEN}${'█'.repeat(filled)}${RESET}${GRAY}${'░'.repeat(empty)}${RESET} ${done}/${total}`;
}

function concurrencyIndicator(active: number, max: number): string {
  const dots = Array.from({ length: max }, (_, i) =>
    i < active ? `${CYAN}●${RESET}` : `${GRAY}○${RESET}`
  ).join(' ');
  return `${dots}  ${active}/${max}`;
}

function plainProgressBar(done: number, total: number): string {
  if (total === 0) return `0/0`;
  return `${done}/${total}`;
}

// ── Public API ──────────────────────────────────────────────

export function initDashboard(
  fetchLimiter: ReturnType<typeof pLimit>,
  llmLimiter: ReturnType<typeof pLimit>,
  githubLimiter: ReturnType<typeof pLimit>,
): void {
  dashState = {
    packagesDone: 0,
    packagesTotal: 0,
    llmDone: 0,
    llmTotal: 0,
    fetchLimiter,
    llmLimiter,
    githubLimiter,
    currentPackage: '',
    currentLlm: [],
    recentLines: [],
  };

  if (isTty) {
    out(ALT_SCREEN);
    repaint();
    repaintTimer = setInterval(repaint, 200);
  } else {
    console.log('🚀 Pi Package Index — CI mode (plain logging)\n');
  }
}

export function stopDashboard(): void {
  if (repaintTimer) {
    clearInterval(repaintTimer);
    repaintTimer = null;
  }

  if (isTty) {
    repaint();
    out(MAIN_SCREEN);
  } else if (dashState) {
    const s = dashState;
    console.log(`\n✨ Done: ${s.packagesDone}/${s.packagesTotal} packages, ${s.llmDone} summaries`);
  }

  dashState = null;
}

export function setPackageTotal(n: number): void {
  const s = ensureState();
  s.packagesTotal = n;
  s.llmTotal = n;
}

export function incPackagesDone(): void {
  const s = ensureState();
  s.packagesDone++;
  if (!isTty && s.packagesDone % 5 === 0) {
    console.log(`  📦 Packages: ${plainProgressBar(s.packagesDone, s.packagesTotal)}`);
  }
}

export function incLlmDone(): void { ensureState().llmDone++; }

export function setCurrentPackage(label: string): void {
  ensureState().currentPackage = label;
  if (!isTty) console.log(`  📦 ${label}`);
}

export function addCurrentLlm(label: string): void { ensureState().currentLlm.push(label); }
export function removeCurrentLlm(label: string): void {
  const idx = ensureState().currentLlm.indexOf(label);
  if (idx >= 0) dashState!.currentLlm.splice(idx, 1);
}

export function logLine(line: string): void {
  const s = ensureState();
  s.recentLines.push(line);
  if (s.recentLines.length > MAX_RECENT) {
    s.recentLines.shift();
  }
  if (!isTty) console.log(`    ${line}`);
}

// ── Render (TUI only) ───────────────────────────────────────

function repaint(): void {
  if (!dashState || !isTty) return;
  const s = dashState;

  out(CLEAR_SCREEN + HOME);

  const w = (str: string) => out(str + '\n');

  w(`${BOLD}${CYAN}Pi Package Index${RESET}\n`);

  w(`${BOLD}Progress${RESET}`);
  w(`  Packages  ${progressBar(s.packagesDone, s.packagesTotal)}`);
  w(`  LLM       ${progressBar(s.llmDone, s.llmTotal)}`);
  w('');

  w(`${BOLD}Concurrency${RESET}`);
  w(`  FETCH ${concurrencyIndicator(s.fetchLimiter.activeCount, s.fetchLimiter.concurrency)}`);
  w(`  LLM   ${concurrencyIndicator(s.llmLimiter.activeCount, s.llmLimiter.concurrency)}`);
  w(`  GH    ${concurrencyIndicator(s.githubLimiter.activeCount, s.githubLimiter.concurrency)}`);
  w('');

  w(`${BOLD}Queues${RESET}`);
  w(
    `  fetch: ${YELLOW}${s.fetchLimiter.pendingCount}${RESET}   ` +
    `llm: ${YELLOW}${s.llmLimiter.pendingCount}${RESET}   ` +
    `gh: ${YELLOW}${s.githubLimiter.pendingCount}${RESET}`
  );
  w('');

  w(`${BOLD}Current${RESET}`);
  w(`  PACKAGE  ${s.currentPackage || DIM + '—' + RESET}`);
  w(`  LLM      ${s.currentLlm.length > 0 ? s.currentLlm.join(', ') : DIM + '—' + RESET}`);
  w('');

  w(`${BOLD}Recent${RESET}`);
  if (s.recentLines.length === 0) {
    w(`  ${DIM}waiting...${RESET}`);
  } else {
    for (const l of s.recentLines) {
      w(`  ${l}`);
    }
  }
}
