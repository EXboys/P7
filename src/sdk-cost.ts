export interface SdkTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface SdkCostSummary {
  costUsd: number;
  usage: SdkTokenUsage;
}

export function emptyTokenUsage(): SdkTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

export function emptySdkCost(): SdkCostSummary {
  return { costUsd: 0, usage: emptyTokenUsage() };
}

export function parseUsage(raw: unknown): SdkTokenUsage {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    inputTokens: Number(u.input_tokens ?? u.inputTokens ?? 0) || 0,
    outputTokens: Number(u.output_tokens ?? u.outputTokens ?? 0) || 0,
    cacheReadInputTokens:
      Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0) || 0,
    cacheCreationInputTokens:
      Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0) || 0,
  };
}

export function addTokenUsage(a: SdkTokenUsage, b: SdkTokenUsage): SdkTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

export function addSdkCost(
  acc: SdkCostSummary,
  part: { costUsd?: number; usage?: SdkTokenUsage },
): SdkCostSummary {
  return {
    costUsd: acc.costUsd + (typeof part.costUsd === "number" ? part.costUsd : 0),
    usage: part.usage ? addTokenUsage(acc.usage, part.usage) : acc.usage,
  };
}

export function totalTokens(usage: SdkTokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}
