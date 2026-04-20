import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StateFile, ReviewedPackage } from './types.js';

const DEFAULT_STATE: StateFile = { packages: [] };

export function loadState(filePath: string): StateFile {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as StateFile;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(filePath: string, state: StateFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function isReviewed(state: StateFile, name: string, version: string): boolean {
  return state.packages.some((p) => p.name === name && p.version === version);
}

export function markReviewed(state: StateFile, pkg: ReviewedPackage): StateFile {
  const filtered = state.packages.filter((p) => p.name !== pkg.name);
  return {
    packages: [...filtered, pkg],
  };
}
