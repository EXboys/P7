import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  legacyProjectDir,
  p7ProjectDir,
  projectSubpathForRead,
  projectSubpathForWrite,
} from "./p7-paths.ts";
import { extractLastJsonBlock } from "./json-utils.ts";
import { readPrompt, runSdkQuery } from "./sdk.ts";
import type { DevAgentConfig } from "./config.ts";
import type { TechDiscoverySnapshot, TechSignal } from "./types.ts";

const STOP = new Set([
  "show",
  "ask",
  "launch",
  "video",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "github",
  "news",
  "dead",
  "economy",
  "theory",
  "developers",
  "unionize",
  "about",
  "what",
  "when",
  "your",
  "have",
  "will",
  "been",
  "they",
  "their",
  "into",
  "more",
  "than",
  "over",
  "after",
  "before",
]);

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function discoverySnapshotPath(projectPath: string, date: string): string {
  const p = join(p7ProjectDir(projectPath), "discovery", `${date}.json`);
  const l = join(legacyProjectDir(projectPath), "discovery", `${date}.json`);
  if (existsSync(p)) return p;
  if (existsSync(l)) return l;
  return p;
}

export function discoverySnapshotFile(projectPath: string, date = todayKey()): string {
  return discoverySnapshotPath(projectPath, date);
}

export function loadSnapshot(projectPath: string, date?: string): TechDiscoverySnapshot | null {
  const path = discoverySnapshotFile(projectPath, date ?? todayKey());
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TechDiscoverySnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(projectPath: string, snapshot: TechDiscoverySnapshot): string {
  const dir = projectSubpathForWrite(projectPath, "discovery");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${snapshot.date}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

export function listSnapshots(projectPath: string, limit = 14): TechDiscoverySnapshot[] {
  const dir = projectSubpathForRead(projectPath, "discovery");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as TechDiscoverySnapshot)
    .filter(Boolean);
}

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);
}

/** 主题 = 高分热点标题（可读），禁止用词频碎片 */
export function deriveThemesFromSignals(signals: TechSignal[], count: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...signals]
    .filter((s) => s.title.length >= 15 && !/unavailable|failed:/i.test(s.title))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const s of sorted) {
    const t = s.title.trim();
    const key = t.slice(0, 48).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.length > 140 ? `${t.slice(0, 137)}...` : t);
    if (out.length >= count) break;
  }
  return out;
}

function isWeakThemeList(themes: string[]): boolean {
  if (themes.length === 0) return true;
  const weak = themes.filter((t) => t.length < 12 || STOP.has(t.toLowerCase()) || !/\s/.test(t));
  return weak.length >= themes.length * 0.6;
}

async function fetchHackerNews(limit: number): Promise<TechSignal[]> {
  try {
    const res = await fetch(
      "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=" + Math.min(limit, 30),
      { signal: AbortSignal.timeout(20000) },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        hits?: { title?: string; url?: string; points?: number; objectID?: string }[];
      };
      return (data.hits ?? []).slice(0, limit).map((h) => ({
        source: "hn" as const,
        title: (h.title ?? "").trim(),
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID ?? ""}`,
        score: h.points,
        tags: tokenize(h.title ?? ""),
      }));
    }
  } catch {
    /* fallback to Firebase API */
  }

  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HN API failed: ${res.status}`);
  const ids = (await res.json()) as number[];
  const slice = ids.slice(0, Math.min(limit, 20));
  const items = await Promise.all(
    slice.map(async (id) => {
      const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!itemRes.ok) return null;
      const item = (await itemRes.json()) as { title?: string; url?: string; score?: number };
      const title = (item.title ?? "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim();
      if (!title) return null;
      return {
        source: "hn" as const,
        title,
        url: item.url ?? `https://news.ycombinator.com/item?id=${id}`,
        score: item.score,
        tags: tokenize(title),
      };
    }),
  );
  return items.filter((x) => x !== null) as TechSignal[];
}

async function fetchGitHubTrending(limit: number): Promise<TechSignal[]> {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const q = `created:>${since}`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(limit, 30)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = (await res.json()) as { items?: { full_name?: string; html_url?: string; stargazers_count?: number; description?: string }[] };
      return (data.items ?? []).slice(0, limit).map((r) => ({
        source: "github" as const,
        title: r.full_name ?? "unknown",
        url: r.html_url ?? "",
        score: r.stargazers_count,
        tags: tokenize(`${r.full_name ?? ""} ${r.description ?? ""}`),
        summary: (r.description ?? "").slice(0, 200),
      }));
    }
  }

  const res = await fetch("https://github.com/trending?since=daily", {
    headers: { "User-Agent": "p7/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub trending page failed: ${res.status}`);
  const html = await res.text();
  const out: TechSignal[] = [];
  const re = /href="\/([^"]+?)\/([^"]+?)"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const repo = `${m[1]}/${m[2]}`;
    const title = m[3].trim();
    if (title.length < 2) continue;
    out.push({
      source: "github",
      title: `${repo} — ${title}`,
      url: `https://github.com/${repo}`,
      tags: tokenize(`${repo} ${title}`),
    });
  }
  return out;
}

export async function fetchTechRadar(cfg: DevAgentConfig): Promise<TechDiscoverySnapshot> {
  const hn = await fetchHackerNews(cfg.discovery.hn_limit);
  let gh: TechSignal[] = [];
  try {
    gh = await fetchGitHubTrending(cfg.discovery.github_limit);
  } catch (e) {
    gh = [{ source: "github", title: `GitHub trending unavailable: ${e instanceof Error ? e.message : String(e)}`, url: "", tags: ["github"] }];
  }
  const signals = [...hn, ...gh].slice(0, cfg.discovery.hn_limit + cfg.discovery.github_limit);
  const themes = deriveThemesFromSignals(signals, cfg.discovery.theme_count);
  const summary = themes.length
    ? `今日 ${themes.length} 条热点标题（HN ${hn.length} / GitHub ${gh.length}）。首推：${themes[0]?.slice(0, 80) ?? ""}`
    : `今日共收录 ${signals.length} 条技术信号。`;
  return {
    date: todayKey(),
    fetchedAt: new Date().toISOString(),
    signals,
    themes,
    summary,
  };
}

export async function synthesizeThemesWithLlm(
  projectPath: string,
  snapshot: TechDiscoverySnapshot,
  northStar: string,
): Promise<{ themes: string[]; summary: string }> {
  const brief = snapshot.signals
    .slice(0, 20)
    .map((s, i) => `${i + 1}. [${s.source}] ${s.title} (${s.url})`)
    .join("\n");
  const prompt = `北极星：${northStar}

今日技术信号：
${brief}

请输出 JSON：
\`\`\`json
{
  "themes": ["主题1", "主题2"],
  "summary": "一段话总结今天最值得跟进的工程方向"
}
\`\`\``;
  const raw = extractLastJsonBlock(
    (
      await runSdkQuery({
        prompt,
        cwd: projectPath,
        systemPrompt: readPrompt("tech-radar.md"),
        role: "selector",
      })
    ).text,
  );
  const parsed = raw as { themes?: string[]; summary?: string };
  return {
    themes: (parsed.themes ?? snapshot.themes).slice(0, 8),
    summary: parsed.summary ?? snapshot.summary,
  };
}

export async function runDiscovery(
  projectPath: string,
  cfg: DevAgentConfig,
  opts: { useLlmThemes?: boolean } = {},
): Promise<TechDiscoverySnapshot> {
  if (!cfg.discovery.enabled) {
    return {
      date: todayKey(),
      fetchedAt: new Date().toISOString(),
      signals: [],
      themes: [],
      summary: "discovery disabled",
    };
  }
  let snap = await fetchTechRadar(cfg);
  if (opts.useLlmThemes !== false && snap.signals.length > 0) {
    try {
      const synth = await synthesizeThemesWithLlm(projectPath, snap, cfg.initial_goal);
      if (!isWeakThemeList(synth.themes)) {
        snap = { ...snap, themes: synth.themes, summary: synth.summary };
      }
    } catch {
      /* 保留标题级 themes */
    }
  }
  saveSnapshot(projectPath, snap);
  return snap;
}

export function formatDiscoveryForPrompt(snapshot: TechDiscoverySnapshot | null): string {
  if (!snapshot || snapshot.signals.length === 0) return "（今日无技术雷达数据）";
  const top = snapshot.signals.slice(0, 15);
  const lines = top.map(
    (s, i) => `${i + 1}. [${s.source}] ${s.title}${s.score ? ` (score=${s.score})` : ""}`,
  );
  return `日期：${snapshot.date}\n主题：${snapshot.themes.join("、") || "无"}\n摘要：${snapshot.summary}\n\n热点：\n${lines.join("\n")}`;
}
