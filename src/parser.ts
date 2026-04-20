/**
 * Parse a GitHub owner/repo from a repository URL.
 * Handles both string URLs and npm repository objects.
 */
export function parseGitHubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;

  const match = url.match(/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/i);
  if (!match) return null;

  const owner = match[1];
  let repo = match[2];

  // Strip .git suffix and trailing punctuation
  repo = repo.replace(/\.git$/, '');
  repo = repo.split(/[?#\s,;\])}>]/)[0];

  if (!owner || !repo) return null;
  return { owner, repo };
}
