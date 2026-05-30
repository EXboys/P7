/** Extract and repair JSON from LLM output (handles Chinese unescaped quotes). */

export function repairJson(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      const rest = raw.slice(i + 1).trimStart();
      const isStructural =
        rest.length === 0 ||
        /^[,}\]:]/.test(rest) ||
        (rest.startsWith('"') && /^"[^"]*"\s*:/.test(rest));
      if (isStructural) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

export function extractLastJsonBlock(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates: string[] = [];
  if (fenced.length > 0) {
    candidates.push(fenced[fenced.length - 1][1].trim());
  }
  const bareMatch = text.match(/\{[\s\S]*\}/);
  if (bareMatch) candidates.push(bareMatch[0]);

  let lastError: Error | null = null;
  for (const raw of candidates.reverse()) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      lastError = e as Error;
      try {
        return JSON.parse(repairJson(raw));
      } catch (e2) {
        lastError = e2 as Error;
      }
    }
  }
  throw lastError ?? new Error("No JSON block found in model output");
}

export function bigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
