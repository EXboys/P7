import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { p7ProjectDir } from "./p7-paths.ts";

export interface RoadmapStep {
  text: string;
  done: boolean;
  commit?: string;
  feature: string;
}

export interface ParsedRoadmap {
  active: RoadmapStep[];
  backlog: string[];
  done: string[];
}

const ROADMAP_FILE = "ROADMAP.md";

export function roadmapPath(projectPath: string): string {
  return join(projectPath, ROADMAP_FILE);
}

export function parseRoadmap(content: string): ParsedRoadmap {
  const active: RoadmapStep[] = [];
  const backlog: string[] = [];
  const done: string[] = [];
  let section: "active" | "backlog" | "done" | null = null;
  let currentFeature = "";

  for (const line of content.split("\n")) {
    if (/^##\s+Active/i.test(line)) {
      section = "active";
      continue;
    }
    if (/^##\s+Backlog/i.test(line)) {
      section = "backlog";
      continue;
    }
    if (/^##\s+Done/i.test(line)) {
      section = "done";
      continue;
    }
    const feat = line.match(/^Feature:\s*(.+)/i);
    if (feat) {
      currentFeature = feat[1].trim();
      continue;
    }
    const step = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (step && section === "active") {
      const done = step[1].toLowerCase() === "x";
      const text = step[2].replace(/\(commit:\s*[a-f0-9]+\)/i, "").trim();
      const commitM = step[2].match(/\(commit:\s*([a-f0-9]+)\)/i);
      active.push({
        text,
        done,
        commit: commitM?.[1],
        feature: currentFeature || "General",
      });
    } else if (section === "backlog" && line.trim().startsWith("-")) {
      backlog.push(line.replace(/^-\s+/, "").trim());
    } else if (section === "done" && line.trim()) {
      done.push(line.trim());
    }
  }
  return { active, backlog, done };
}

export function loadRoadmap(projectPath: string): ParsedRoadmap | null {
  const path = roadmapPath(projectPath);
  if (!existsSync(path)) return null;
  return parseRoadmap(readFileSync(path, "utf-8"));
}

export function firstUnfinishedStep(projectPath: string): RoadmapStep | null {
  const rm = loadRoadmap(projectPath);
  if (!rm) return null;
  return rm.active.find((s) => !s.done) ?? null;
}

export function isRoadmapExhausted(projectPath: string): boolean {
  const rm = loadRoadmap(projectPath);
  if (!rm) return true;
  return rm.active.length === 0 || rm.active.every((s) => s.done);
}

export async function markRoadmapStepDone(
  projectPath: string,
  stepHint: string,
  commitSha: string,
): Promise<void> {
  const path = roadmapPath(projectPath);
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let firstUnchecked = -1;
  let section: "active" | "backlog" | "done" | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Active/i.test(lines[i])) section = "active";
    else if (/^##\s+Backlog/i.test(lines[i])) section = "backlog";
    else if (/^##\s+Done/i.test(lines[i])) section = "done";

    if (section !== "active" || !/^-\s+\[\s\]/.test(lines[i])) continue;

    if (firstUnchecked < 0) firstUnchecked = i;
    const normalizedLine = lines[i].toLowerCase();
    const normalizedHint = stepHint.toLowerCase();
    if (
      normalizedLine.includes(normalizedHint) ||
      normalizedLine.includes(normalizedHint.slice(0, 12))
    ) {
      lines[i] = lines[i].replace(/^- \[ \]/, "- [x]") + ` (commit: ${commitSha})`;
      break;
    }
  }
  if (!lines.some((line) => line.includes(`commit: ${commitSha}`)) && firstUnchecked >= 0) {
    lines[firstUnchecked] = lines[firstUnchecked].replace(/^- \[ \]/, "- [x]") + ` (commit: ${commitSha})`;
  }
  writeFileSync(path, lines.join("\n"));
}

export function recommendRoadmapGoal(projectPath: string): string | null {
  const step = firstUnfinishedStep(projectPath);
  return step ? step.text : null;
}

export function backupRoadmap(projectPath: string): string {
  const src = roadmapPath(projectPath);
  if (!existsSync(src)) return "";
  const histDir = join(p7ProjectDir(projectPath), "roadmap-history");
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const dest = join(histDir, `ROADMAP-${Date.now()}.md`);
  writeFileSync(dest, readFileSync(src, "utf-8"));
  return dest;
}
