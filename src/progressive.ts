import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageData, PackagesJson } from './types.js';

/**
 * Progressively write packages.json as packages complete.
 * Flushes every N completions AND on a timer, so crashes lose at most
 * a few seconds / a few packages of work.
 */
export class ProgressiveSaver {
  private map = new Map<string, PackageData>();
  private completed = 0;
  private lastFlush = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushed = false;

  constructor(
    private outputDir: string,
    private query: string,
    private flushEvery: number = 10,
    private flushIntervalMs: number = 10_000,
  ) {}

  /** Seed with existing packages so we never overwrite them. */
  seed(existing: PackageData[]): void {
    for (const p of existing) {
      this.map.set(p.name, p);
    }
  }

  /** Mark a package as completed and flush if needed. */
  markComplete(pkg: PackageData): void {
    this.map.set(pkg.name, pkg);
    this.completed++;

    if (this.completed % this.flushEvery === 0) {
      this.flush();
    }
  }

  /** Start the background auto-flush timer. */
  start(): void {
    this.flush(); // initial flush
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  /** Stop the background timer and do a final flush. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  /** Write packages.json to disk from the current Map. */
  flush(): void {
    const now = Date.now();
    if (this.flushed && now - this.lastFlush < 500) {
      // Debounce rapid successive flushes
      return;
    }

    const packages = Array.from(this.map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const data: PackagesJson = {
      generatedAt: new Date().toISOString(),
      query: this.query,
      total: packages.length,
      packages,
    };

    mkdirSync(this.outputDir, { recursive: true });
    const path = join(this.outputDir, 'packages.json');
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');

    this.lastFlush = now;
    this.flushed = true;
  }

  getPackages(): PackageData[] {
    return Array.from(this.map.values());
  }
}
