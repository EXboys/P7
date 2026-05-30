import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const BEGIN = "<!-- P7_LESSONS_BEGIN -->";
const END = "<!-- P7_LESSONS_END -->";
const LEGACY_BEGIN = "<!-- DEV_AGENT_LESSONS_BEGIN -->";
const LEGACY_END = "<!-- DEV_AGENT_LESSONS_END -->";

function lessonMarkers(content: string): { begin: string; end: string; beginIdx: number; endIdx: number } {
  if (content.includes(BEGIN)) {
    return { begin: BEGIN, end: END, beginIdx: content.indexOf(BEGIN), endIdx: content.indexOf(END) };
  }
  if (content.includes(LEGACY_BEGIN)) {
    return {
      begin: LEGACY_BEGIN,
      end: LEGACY_END,
      beginIdx: content.indexOf(LEGACY_BEGIN),
      endIdx: content.indexOf(LEGACY_END),
    };
  }
  return { begin: BEGIN, end: END, beginIdx: -1, endIdx: -1 };
}
const MAX_ENTRIES = 50;

function claudeMdPath(projectPath: string): string {
  const p = join(projectPath, ".claude", "CLAUDE.md");
  if (!existsSync(join(projectPath, ".claude"))) {
    mkdirSync(join(projectPath, ".claude"), { recursive: true });
  }
  return p;
}

export async function appendLesson(projectPath: string, line: string): Promise<void> {
  const path = claudeMdPath(projectPath);
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = `- ${ts} ${line}`;

  let content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  let markers = lessonMarkers(content);
  if (markers.beginIdx < 0) {
    content += `\n\n${BEGIN}\n## Lessons learned (auto-curated by P7)\n${END}\n`;
    markers = lessonMarkers(content);
  }

  const before = content.slice(0, markers.beginIdx);
  const section = content.slice(markers.beginIdx + markers.begin.length, markers.endIdx);
  const afterTail = content.slice(markers.endIdx + markers.end.length);

  const lines = section.split("\n").filter((l) => l.trim().startsWith("-"));
  lines.push(entry);
  const trimmed = lines.slice(-MAX_ENTRIES);
  const newSection = `\n## Lessons learned (auto-curated by P7)\n${trimmed.join("\n")}\n`;

  writeFileSync(path, `${before}${BEGIN}${newSection}${END}${afterTail}`);
}
