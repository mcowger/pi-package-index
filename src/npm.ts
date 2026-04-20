import { searchPackages, getPackument, type SearchResults } from 'query-registry';
import pLimit from 'p-limit';
import type { PackageData } from './types.js';
import { parseGitHubRepo } from './parser.js';
import { fetchReadme, fetchStars, githubLimit } from './github.js';

export const SEARCH_QUERY = 'keywords:pi-package';
const SEARCH_PAGE_SIZE = 250;
const FETCH_DELAY_MS = 300;
const SEARCH_DELAY_MS = 500;

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
async function fetchPackageReadme(name: string, repoUrl: string | null): Promise<{ readme: string | null; source: 'npm' | 'github' | null; stars: number | null }> {
  // Try npm packument first
  try {
    const packument = await getPackument(name);
    if (packument.readme && packument.readme.length >= 200) {
      return { readme: packument.readme, source: 'npm', stars: null };
    }
  } catch (err: any) {
    console.warn(`  ⚠️  Failed to fetch packument for ${name}: ${err.message}`);
  }

  // Fall back to GitHub
  const gh = parseGitHubRepo(repoUrl);
  if (!gh) {
    return { readme: null, source: null, stars: null };
  }

  const readme = await githubLimit(() => fetchReadme(gh.owner, gh.repo));
  const stars = await githubLimit(() => fetchStars(gh.owner, gh.repo));

  return { readme, source: readme ? 'github' : null, stars };
}

/**
 * Process a single search result into a PackageData object.
 */
export async function processPackage(
  searchObj: SearchResults['objects'][number],
): Promise<PackageData> {
  const pkg = searchObj.package;
  const name = pkg.name;

  console.log(`  📦 Processing ${name}@${pkg.version}`);

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
    summary: null, // filled in later by LLM
    stars,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch full metadata for all given search results.
 * Skips packages already in the skip set.
 */
export interface FetchCallbacks {
  onStart?: (name: string) => void;
  onDone?: (name: string) => void;
}

export async function fetchPackages(
  searchResults: Map<string, SearchResults['objects'][number]>,
  skipNames: Set<string>,
  concurrency: number,
  callbacks?: FetchCallbacks,
): Promise<PackageData[]> {
  const limit = pLimit({ concurrency });
  const toFetch: SearchResults['objects'][number][] = [];

  for (const [name, obj] of searchResults) {
    if (skipNames.has(name)) {
      console.log(`  ⏭️  Skipping ${name} (already at current version)`);
      continue;
    }
    toFetch.push(obj);
  }

  if (toFetch.length === 0) {
    console.log('  ✅ All packages up to date');
    return [];
  }

  console.log(`\n📦 Fetching ${toFetch.length} package(s)...\n`);

  const results = await Promise.all(
    toFetch.map((obj) =>
      limit(async () => {
        try {
          callbacks?.onStart?.(obj.package.name);
          await sleep(FETCH_DELAY_MS);
          const result = await processPackage(obj);
          callbacks?.onDone?.(obj.package.name);
          return result;
        } catch (err: any) {
          console.error(`  ❌ Failed to process ${obj.package.name}: ${err.message}`);
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
      }),
    ),
  );

  return results;
}
