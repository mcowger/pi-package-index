import { searchPackages, getPackument, type SearchResults } from 'query-registry';
import type { PackageData } from './types.js';
import { parseGitHubRepo } from './parser.js';
import { fetchReadme, fetchStars, githubLimit } from './github.js';

const SEARCH_QUERY = 'keywords:pi-package';
const SEARCH_PAGE_SIZE = 250;
const SEARCH_DELAY_MS = 500;
const FETCH_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Search npm registry for all packages matching the keyword query.
 * Returns a deduplicated Map keyed by package name.
 */
export async function searchNpmPackages(): Promise<Map<string, SearchResults['objects'][number]>> {
  const all = new Map<string, SearchResults['objects'][number]>();
  let from = 0;

  while (true) {
    console.log(`  🔍 Searching npm: ${SEARCH_QUERY} (from=${from}, size=${SEARCH_PAGE_SIZE})`);
    const results = await searchPackages({
      text: SEARCH_QUERY,
      size: SEARCH_PAGE_SIZE,
      from,
    });

    for (const obj of results.objects) {
      const name = obj.package.name;
      if (!all.has(name)) {
        all.set(name, obj);
      }
    }

    console.log(`     Found ${results.objects.length} results (total=${results.total}, unique so far=${all.size})`);

    if (all.size >= results.total || results.objects.length === 0) {
      break;
    }

    from += SEARCH_PAGE_SIZE;
    await sleep(SEARCH_DELAY_MS);
  }

  console.log(`✅ Search complete: ${all.size} unique packages`);
  return all;
}

/**
 * Fetch the README for a package from its npm packument.
 * Falls back to GitHub repository README if npm has none or it's very short.
 */
/**
 * Raw registry fetch that bypasses Zod validation.
 * Used when getPackument throws due to schema issues in unrelated fields.
 */
async function fetchRawPackumentReadme(name: string): Promise<string | null> {
  try {
    const encoded = name.replace('/', '%2F');
    const res = await fetch(`https://registry.npmjs.org/${encoded}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.readme === 'string' ? data.readme : null;
  } catch {
    return null;
  }
}

async function fetchUnpkgReadme(name: string): Promise<string | null> {
  for (const filename of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      const res = await fetch(`https://unpkg.com/${name}@latest/${filename}`, { redirect: 'follow' });
      if (res.ok) {
        const text = await res.text();
        if (text.length > 0 && !text.startsWith('<!DOCTYPE')) {
          return text;
        }
      }
    } catch {
      // try next filename
    }
  }
  return null;
}

async function fetchPackageReadme(name: string, repoUrl: string | null): Promise<{ readme: string | null; source: 'npm' | 'github' | null; stars: number | null }> {
  let npmReadme: string | null = null;

  // Try npm packument first
  try {
    const packument = await getPackument(name);
    if (packument.readme && packument.readme.length >= 200) {
      return { readme: packument.readme, source: 'npm', stars: null };
    }
    if (packument.readme) {
      npmReadme = packument.readme;
      console.log(`    📄 ${name}: npm README short (${packument.readme.length} chars), trying GitHub...`);
    } else {
      console.log(`    📄 ${name}: no README on npm, trying GitHub...`);
    }
  } catch (err: any) {
    console.warn(`    ⚠️  ${name}: npm packument failed (${err.message}), trying raw registry...`);
    const rawReadme = await fetchRawPackumentReadme(name);
    if (rawReadme && rawReadme.length >= 200) {
      console.log(`    ✅ ${name}: README from raw registry (${rawReadme.length} chars)`);
      return { readme: rawReadme, source: 'npm', stars: null };
    }
    if (rawReadme) {
      npmReadme = rawReadme;
      console.log(`    📄 ${name}: raw registry README short (${rawReadme.length} chars), trying GitHub...`);
    } else {
      console.log(`    📄 ${name}: no README on npm, trying GitHub...`);
    }
  }

  // Fall back to GitHub
  const gh = parseGitHubRepo(repoUrl);
  if (!gh) {
    // No GitHub repo — try unpkg before giving up
    const unpkgReadme = await fetchUnpkgReadme(name);
    if (unpkgReadme) {
      console.log(`    ✅ ${name}: README from unpkg (${unpkgReadme.length} chars)`);
      return { readme: unpkgReadme, source: 'npm', stars: null };
    }
    if (npmReadme) {
      console.log(`    ✅ ${name}: using short npm README (${npmReadme.length} chars)`);
      return { readme: npmReadme, source: 'npm', stars: null };
    }
    console.log(`    📄 ${name}: no repository link, giving up`);
    return { readme: null, source: null, stars: null };
  }

  const readme = await githubLimit(() => fetchReadme(gh.owner, gh.repo));
  const stars = await githubLimit(() => fetchStars(gh.owner, gh.repo));

  if (readme) {
    console.log(`    ✅ ${name}: README from GitHub (${readme.length} chars)`);
    return { readme, source: 'github' as const, stars };
  }

  // Try unpkg as last resort
  const unpkgReadme = await fetchUnpkgReadme(name);
  if (unpkgReadme) {
    console.log(`    ✅ ${name}: README from unpkg (${unpkgReadme.length} chars)`);
    return { readme: unpkgReadme, source: 'npm', stars };
  }

  if (npmReadme) {
    console.log(`    ✅ ${name}: using short npm README (${npmReadme.length} chars)`);
    return { readme: npmReadme, source: 'npm', stars };
  }

  console.log(`    ❌ ${name}: no README anywhere (${gh.owner}/${gh.repo})`);
  return { readme: null, source: null, stars };
}

/**
 * Fetch full metadata for a single search result.
 * Returns a PackageData with readme but no summary (summary is added later).
 */
export async function fetchPackageData(
  searchObj: SearchResults['objects'][number],
): Promise<PackageData> {
  const pkg = searchObj.package;
  const name = pkg.name;

  const repoUrl = pkg.links?.repository || null;
  const { readme, source, stars } = await fetchPackageReadme(name, repoUrl);

  return {
    name,
    version: pkg.version,
    description: pkg.description || null,
    keywords: pkg.keywords || [],
    date: pkg.date,
    publisher: pkg.publisher?.username || null,
    links: {
      npm: pkg.links?.npm || `https://www.npmjs.com/package/${name}`,
      homepage: pkg.links?.homepage || null,
      repository: repoUrl,
      bugs: pkg.links?.bugs || null,
    },
    readme,
    readmeSource: source,
    summary: null,
    stars,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Build a synthetic search result object from existing PackageData.
 * Used by the repair command to re-fetch packages that previously failed.
 */
export function buildSearchObjFromPackage(pkg: { name: string; version: string; description: string | null; keywords: string[]; date: string; publisher: string | null; links: { npm: string; homepage: string | null; repository: string | null; bugs: string | null } }): SearchResults['objects'][number] {
  return {
    package: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      keywords: pkg.keywords,
      date: pkg.date,
      publisher: pkg.publisher ? { username: pkg.publisher, email: '' } : undefined,
      links: {
        npm: pkg.links.npm,
        homepage: pkg.links.homepage || undefined,
        repository: pkg.links.repository || undefined,
        bugs: pkg.links.bugs || undefined,
      },
      // required by type but not used by fetchPackageData
      maintainers: [],
    },
    score: { final: 0, detail: { quality: 0, popularity: 0, maintenance: 0 } },
    searchScore: 0,
    downloads: { monthly: 0, weekly: 0 },
    dependents: 0,
    updated: pkg.date,
    flags: { insecure: false },
  } as unknown as SearchResults['objects'][number];
}

export { SEARCH_QUERY };
