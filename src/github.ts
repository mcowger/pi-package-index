import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';

/** Concurrency limiter for GitHub API calls — keeps us under rate limits. */
export const githubLimit = pLimit({ concurrency: 5 });

let _octokit: Octokit | null = null;
let _authed: boolean | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const token = process.env.GH_TOKEN;
    _authed = !!token;
    if (!token) {
      console.warn('⚠️  No GH_TOKEN set. Unauthenticated API limit is 60 requests/hour.');
    }
    _octokit = new Octokit(token ? { auth: token } : {});
  }
  return _octokit;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries: number = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status || err?.response?.status;

      if (status === 403) {
        const msg = err?.response?.data?.message || err.message || '';
        if (msg.includes('rate limit') || msg.includes('API rate limit')) {
          if (attempt < retries) {
            const retryAfter = err?.response?.headers?.['retry-after'];
            const resetTime = err?.response?.headers?.['x-ratelimit-reset'];
            let waitMs: number;
            if (retryAfter) {
              waitMs = parseInt(retryAfter, 10) * 1000;
            } else if (resetTime) {
              waitMs = Math.max(parseInt(resetTime, 10) * 1000 - Date.now(), 2000);
            } else {
              const base = Math.pow(2, attempt + 1) * 1000;
              const jitter = Math.random() * 1000;
              waitMs = base + jitter;
            }
            console.warn(`    ⏳ Rate limited (403), retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
            await sleep(waitMs);
            continue;
          }
        }
        throw err;
      }

      if (status === 429 && attempt < retries) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        let waitMs: number;
        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else {
          const base = Math.pow(2, attempt + 1) * 1000;
          const jitter = Math.random() * 1000;
          waitMs = base + jitter;
        }
        console.warn(`    ⏳ Rate limited (429), retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

export async function fetchReadme(owner: string, repo: string): Promise<string | null> {
  const octokit = getOctokit();
  try {
    const { data } = await withRetry(() =>
      octokit.rest.repos.getReadme({ owner, repo }),
    );
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err: any) {
    const status = err?.status;
    if (status === 404) return null;
    if (status === 403) {
      console.warn(`    🔒 403 Forbidden for ${owner}/${repo} README`);
      return null;
    }
    console.warn(`    ❌ Error fetching README for ${owner}/${repo}: ${err.message}`);
    return null;
  }
}

export async function fetchStars(owner: string, repo: string): Promise<number | null> {
  const octokit = getOctokit();
  try {
    const { data } = await withRetry(() =>
      octokit.rest.repos.get({ owner, repo }),
    );
    return data.stargazers_count ?? null;
  } catch (err: any) {
    const status = err?.status;
    if (status === 403) {
      console.warn(`    🔒 403 Forbidden for ${owner}/${repo} info`);
    } else if (status !== 404) {
      console.warn(`    ❌ Error fetching info for ${owner}/${repo}: ${err.message}`);
    }
    return null;
  }
}
