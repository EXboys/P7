import type { JobRow, JobStatus } from "./queue/types.ts";

export type JobListQuery = {
  page?: number;
  perPage?: number;
  alias?: string;
  status?: string;
  kind?: string;
};

export type JobListPage = {
  jobs: JobRow[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

const VALID_STATUS = new Set<JobStatus>(["pending", "running", "done", "failed"]);

export function normalizeJobListQuery(opts: JobListQuery = {}): Required<
  Pick<JobListQuery, "page" | "perPage">
> &
  Pick<JobListQuery, "alias" | "status" | "kind"> {
  const perPage = Math.min(100, Math.max(10, opts.perPage ?? 20));
  const page = Math.max(1, opts.page ?? 1);
  const status =
    opts.status && VALID_STATUS.has(opts.status as JobStatus)
      ? (opts.status as JobStatus)
      : undefined;
  const alias = opts.alias?.trim() || undefined;
  const kind = opts.kind?.trim() || undefined;
  return { page, perPage, alias, status, kind };
}

export function paginateJobRows(jobs: JobRow[], opts: JobListQuery = {}): JobListPage {
  const { page, perPage, alias, status, kind } = normalizeJobListQuery(opts);
  let filtered = jobs;
  if (alias) filtered = filtered.filter((j) => j.project_alias === alias);
  if (status) filtered = filtered.filter((j) => j.status === status);
  if (kind) filtered = filtered.filter((j) => j.kind === kind);
  filtered = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * perPage;
  return {
    jobs: filtered.slice(start, start + perPage),
    total,
    page: safePage,
    perPage,
    totalPages,
  };
}
