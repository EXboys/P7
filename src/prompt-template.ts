/**
 * 轻量 Prompt 模板引擎
 *
 * 借鉴 Pandoc Templates「模板与数据分离」的设计模式，提供：
 * - {{key}} 变量插值
 * - {{$if key}}...{{$/if}} 条件渲染
 * - 零外部依赖，正则 + 状态机实现
 */

const TAG_RE = /\{\{(?:\$if\s+\w+|\$\/if|\w+)\}\}/g;

function findMatchingClose(template: string, startPos: number): number {
  let depth = 1;
  TAG_RE.lastIndex = startPos;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(template)) !== null) {
    const tag = match[0];
    if (tag.startsWith("{{$if ")) {
      depth++;
    } else if (tag === "{{$/if}}") {
      depth--;
      if (depth === 0) return match.index;
    }
  }
  return -1;
}

/**
 * 渲染模板字符串，将 {{key}} 替换为 vars[key]，处理 {{$if key}} 条件块。
 *
 * @throws 若引用了 vars 中不存在的 key
 * @throws 若存在未闭合的 {{$if key}}
 * @throws 若存在孤立的 {{$/if}}
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let result = "";
  let i = 0;

  while (i < template.length) {
    const tagStart = template.indexOf("{{", i);
    if (tagStart === -1) {
      result += template.slice(i);
      break;
    }

    // 追加标签前的纯文本
    result += template.slice(i, tagStart);

    const tagEnd = template.indexOf("}}", tagStart);
    if (tagEnd === -1) {
      // 未闭合的 {{ — 保留原样
      result += template.slice(tagStart);
      break;
    }

    const rawTag = template.slice(tagStart, tagEnd + 2);
    const inner = template.slice(tagStart + 2, tagEnd).trim();

    if (inner.startsWith("$if ")) {
      const key = inner.slice(4).trim();
      const closingIdx = findMatchingClose(template, tagEnd + 2);
      if (closingIdx === -1) {
        throw new Error(`Unclosed {{$if ${key}}} in template`);
      }
      const body = template.slice(tagEnd + 2, closingIdx);
      if (vars[key]) {
        result += renderTemplate(body, vars);
      }
      // 跳过 {{$/if}}（8 字符）
      i = closingIdx + 8;
    } else if (inner === "$/if") {
      throw new Error(`Unexpected {{$/if}} without matching {{$if}}`);
    } else {
      if (!(inner in vars)) {
        throw new Error(`Missing template variable: "${inner}"`);
      }
      result += String(vars[inner]);
      i = tagEnd + 2;
    }
  }

  return result;
}
