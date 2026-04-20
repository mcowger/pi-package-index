import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateHtml } from './html.js';
import type { PackagesJson } from './types.js';

export function readPackagesJson(outputDir: string): PackagesJson | null {
  const path = join(outputDir, 'packages.json');
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as PackagesJson;
  } catch {
    return null;
  }
}

export function writePackagesJson(data: PackagesJson, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, 'packages.json');
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

/**
 * Render packages.json → index.html
 */
export function renderIndex(outputDir: string): string | null {
  const data = readPackagesJson(outputDir);
  if (!data) {
    console.log('No packages.json found to render.');
    return null;
  }

  console.log(`🎨 Rendering ${data.packages.length} packages to HTML...`);

  const html = generateHtml(data);
  const htmlPath = join(outputDir, 'index.html');
  writeFileSync(htmlPath, html, 'utf-8');

  console.log(`  📄 ${htmlPath}`);
  console.log(`✅ Render complete!`);
  return htmlPath;
}
