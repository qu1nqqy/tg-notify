import type { ApiJob } from './types.js';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Release {
  html_url: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  created_at: string;
  /** created_at у релиза — дата коммита, а не релиза, поэтому смотрим published_at. */
  published_at: string | null;
  target_commitish: string;
  draft: boolean;
}

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly apiUrl: string,
    private readonly repo: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiUrl}/repos/${this.repo}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tg-notify',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 403 || res.status === 404) hint = ' (нужно permissions: actions: read у GITHUB_TOKEN)';
      throw new GitHubError(res.status, `GitHub ${path}: ${res.status} ${text.slice(0, 200)}${hint}`);
    }
    return (await res.json()) as T;
  }

  /** Задачи текущей попытки запуска, со всеми страницами. */
  async listJobs(runId: string, attempt: string): Promise<ApiJob[]> {
    const jobs: ApiJob[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.get<{ total_count: number; jobs: ApiJob[] }>(
        `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      );
      jobs.push(...data.jobs);
      if (jobs.length >= data.total_count || data.jobs.length === 0) break;
    }
    // Порядок как в UI: по времени создания, а API отдаёт по id — это то же самое.
    return jobs.sort((a, b) => a.id - b.id);
  }

  async getRun(runId: string): Promise<{ run_started_at: string | null; created_at: string; name: string | null }> {
    return this.get(`/actions/runs/${runId}`);
  }

  async listReleases(): Promise<Release[]> {
    return this.get(`/releases?per_page=20`);
  }
}

/**
 * Релиз, созданный этим запуском: по тегу, если он известен, иначе самый новый
 * релиз, созданный после начала запуска.
 */
export function pickRelease(releases: readonly Release[], opts: { tag?: string; since?: string }): Release | undefined {
  const published = releases.filter((r) => !r.draft);
  if (opts.tag) return published.find((r) => r.tag_name === opts.tag);
  if (!opts.since) return undefined;
  const since = Date.parse(opts.since);
  return published
    .filter((r) => r.published_at && Date.parse(r.published_at) >= since)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))[0];
}
