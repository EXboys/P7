function ghRun(
  cwd: string,
  args: string[],
): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return { ok: proc.exitCode === 0, out: stdout || stderr };
}

export type OpenPr = {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  labels: string[];
  mergeable: string;
  mergeStateStatus: string;
};

export function listOpenPullRequests(
  projectPath: string,
  opts?: { label?: string; limit?: number },
): OpenPr[] {
  const limit = opts?.limit ?? 30;
  const args = [
    "gh",
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,url,title,headRefName,labels,mergeable,mergeStateStatus",
  ];
  if (opts?.label) {
    args.push("--label", opts.label);
  }
  const r = ghRun(projectPath, args);
  if (!r.ok) return [];
  try {
    const rows = JSON.parse(r.out) as Array<{
      number: number;
      url: string;
      title: string;
      headRefName: string;
      labels?: Array<{ name: string }>;
      mergeable: string;
      mergeStateStatus: string;
    }>;
    return rows.map((row) => ({
      number: row.number,
      url: row.url,
      title: row.title,
      headRefName: row.headRefName,
      labels: (row.labels ?? []).map((l) => l.name),
      mergeable: row.mergeable,
      mergeStateStatus: row.mergeStateStatus,
    }));
  } catch {
    return [];
  }
}
