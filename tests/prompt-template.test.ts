import { describe, expect, test } from "bun:test";
import { renderTemplate } from "../src/prompt-template.ts";

describe("renderTemplate", () => {
  // 1. 纯文本无占位符 → 原样返回
  test("returns plain text unchanged when no placeholders", () => {
    const input = "You are a helpful assistant.";
    const result = renderTemplate(input, {});
    expect(result).toBe("You are a helpful assistant.");
  });

  // 2. 单变量替换
  test("replaces single {{key}} with value from vars", () => {
    const input = "Hello, {{name}}!";
    const result = renderTemplate(input, { name: "Alice" });
    expect(result).toBe("Hello, Alice!");
  });

  // 3. 多变量替换
  test("replaces multiple variables in one template", () => {
    const input = "Project: {{project}} at {{path}} on branch {{branch}}.";
    const result = renderTemplate(input, {
      project: "P7",
      path: "/home/dev/p7",
      branch: "main",
    });
    expect(result).toBe("Project: P7 at /home/dev/p7 on branch main.");
  });

  // 4. 缺失变量抛错
  test("throws when variable is missing from vars", () => {
    const input = "Hello, {{name}}!";
    expect(() => renderTemplate(input, {})).toThrow('Missing template variable: "name"');
  });

  // 5. {{$if}} 条件为 truthy → 保留块内容
  test("keeps content inside {{$if}} block when condition is truthy", () => {
    const input = "Before\n{{$if debug}}DEBUG MODE\n{{$/if}}After";
    const result = renderTemplate(input, { debug: true });
    expect(result).toBe("Before\nDEBUG MODE\nAfter");
  });

  // 6. {{$if}} 条件为 falsy → 移除块内容
  test("removes content inside {{$if}} block when condition is falsy", () => {
    const input = "Before\n{{$if debug}}DEBUG MODE\n{{$/if}}After";
    const result = renderTemplate(input, { debug: false });
    expect(result).toBe("Before\nAfter");
  });

  test("removes {{$if}} block when key is undefined", () => {
    const input = "Start\n{{$if missing}}hidden{{$/if}}\nEnd";
    const result = renderTemplate(input, {});
    expect(result).toBe("Start\n\nEnd");
  });

  // 7. 未闭合 {{$if}} 抛语法错误
  test("throws on unclosed {{$if}} block", () => {
    const input = "Start\n{{$if debug}}never closed";
    expect(() => renderTemplate(input, { debug: true })).toThrow("Unclosed {{$if debug}}");
  });

  // 8. 孤立的 {{$/if}} 抛语法错误
  test("throws on stray {{$/if}} without opening {{$if}}", () => {
    const input = "Start\n{{$/if}}End";
    expect(() => renderTemplate(input, {})).toThrow("Unexpected {{$/if}}");
  });

  // 9. 条件块内嵌套变量渲染
  test("renders variables inside a conditional block", () => {
    const input = "{{$if user}}Welcome, {{user}}!{{$/if}}";
    const result = renderTemplate(input, { user: "Bob" });
    expect(result).toBe("Welcome, Bob!");
  });

  // 10. 嵌套条件块
  test("handles nested {{$if}} blocks", () => {
    const input = "{{$if a}}A{{$if b}}B{{$/if}}A2{{$/if}}";
    const result = renderTemplate(input, { a: true, b: true });
    expect(result).toBe("ABA2");
  });

  test("inner falsy condition removes inner block only", () => {
    const input = "{{$if a}}A{{$if b}}B{{$/if}}A2{{$/if}}";
    const result = renderTemplate(input, { a: true, b: false });
    expect(result).toBe("AA2");
  });

  // 11. 非字符串变量转换为字符串
  test("converts non-string values via String()", () => {
    const input = "Count: {{count}}, Ratio: {{ratio}}";
    const result = renderTemplate(input, { count: 42, ratio: 0.85 });
    expect(result).toBe("Count: 42, Ratio: 0.85");
  });
});
