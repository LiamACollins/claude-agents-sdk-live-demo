import type { RunUsage } from "./run-events";

const TOKENS_PER_MILLION = 1_000_000;
export const PRICE_CATALOG_ACCESSED_ON = "2026-09-23";

type InputAccounting = "cached-subset" | "separate-cache-buckets";

type TokenRates = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  maxInputTokens?: number;
};

type EffectiveRates = {
  before?: string;
  from?: string;
  tiers: TokenRates[];
};

type ModelPricing = {
  provider: "Anthropic" | "Google" | "OpenAI";
  rates: EffectiveRates[];
  note?: string;
};

type CostResolutionInput = {
  modelId: string;
  usage: RunUsage;
  requestUsages?: RunUsage[];
  inputAccounting: InputAccounting;
  nativeCostUsd?: number;
  nativeSource?: string;
  at?: Date;
};

export type CostResolution = {
  costUsd?: number;
  costSource: string;
};

// USD per one million tokens. Keep exact model IDs here: unknown aliases fail closed.
const PRICE_CATALOG: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    provider: "Anthropic",
    rates: [{ tiers: [{ input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 }] }],
    note: "5m cache-write rate",
  },
  "claude-sonnet-5": {
    provider: "Anthropic",
    rates: [{ tiers: [{ input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 }] }],
    note: "5m cache-write rate",
  },
  "claude-opus-5": {
    provider: "Anthropic",
    rates: [{ tiers: [{ input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }] }],
    note: "5m cache-write rate",
  },
  "gpt-5.4-nano": {
    provider: "OpenAI",
    rates: [{ tiers: [{ input: 0.2, output: 1.25, cachedInput: 0.02 }] }],
  },
  "gpt-5.4-mini": {
    provider: "OpenAI",
    rates: [{ tiers: [{ input: 0.75, output: 4.5, cachedInput: 0.075 }] }],
  },
  "gpt-5.1": {
    provider: "OpenAI",
    rates: [{ tiers: [{ input: 1.25, output: 10, cachedInput: 0.125 }] }],
  },
  "gemini-3.1-flash-lite": {
    provider: "Google",
    rates: [{ tiers: [{ input: 0.25, output: 1.5, cachedInput: 0.025 }] }],
  },
  "gemini-3.8-flash": {
    provider: "Google",
    rates: [
      {
        before: "2027-01-01T00:00:00.000Z",
        tiers: [{ input: 0.75, output: 3.75, cachedInput: 0.075 }],
      },
      {
        from: "2027-01-01T00:00:00.000Z",
        tiers: [{ input: 1.5, output: 7.5, cachedInput: 0.15 }],
      },
    ],
    note: "context-cache storage excluded",
  },
  "gemini-3.1-pro-preview": {
    provider: "Google",
    rates: [
      {
        tiers: [
          { input: 2, output: 12, cachedInput: 0.2, maxInputTokens: 200_000 },
          { input: 4, output: 18, cachedInput: 0.4 },
        ],
      },
    ],
    note: "context-cache storage excluded",
  },
};

function validTokenCount(value: number | undefined) {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

function applicableRates(model: ModelPricing, at: Date) {
  const timestamp = at.getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return model.rates.find((entry) => {
    const starts = entry.from ? Date.parse(entry.from) : Number.NEGATIVE_INFINITY;
    const ends = entry.before ? Date.parse(entry.before) : Number.POSITIVE_INFINITY;
    return timestamp >= starts && timestamp < ends;
  });
}

function estimateRequestCost(
  usage: RunUsage,
  rateSet: EffectiveRates,
  inputAccounting: InputAccounting,
) {
  if (
    !validTokenCount(usage.input) ||
    !validTokenCount(usage.output) ||
    !validTokenCount(usage.cachedInput) ||
    !validTokenCount(usage.cacheWrite)
  ) {
    return undefined;
  }

  const cachedInput = usage.cachedInput ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const uncachedInput =
    inputAccounting === "cached-subset" ? usage.input - cachedInput : usage.input;
  if (uncachedInput < 0) return undefined;

  const tier = rateSet.tiers.find(
    ({ maxInputTokens }) => maxInputTokens === undefined || usage.input <= maxInputTokens,
  );
  if (!tier) return undefined;

  // Reasoning/thinking tokens are already included in provider output tokens.
  const dollarTokens =
    uncachedInput * tier.input +
    cachedInput * (tier.cachedInput ?? tier.input) +
    cacheWrite * (tier.cacheWrite ?? tier.input) +
    usage.output * tier.output;
  return dollarTokens / TOKENS_PER_MILLION;
}

export function resolveRunCost({
  modelId,
  usage,
  requestUsages,
  inputAccounting,
  nativeCostUsd,
  nativeSource,
  at = new Date(),
}: CostResolutionInput): CostResolution {
  if (Number.isFinite(nativeCostUsd) && (nativeCostUsd ?? -1) >= 0) {
    return {
      costUsd: nativeCostUsd,
      costSource: nativeSource ?? "Native SDK cost estimate",
    };
  }

  const pricing = PRICE_CATALOG[modelId];
  if (!pricing) {
    return { costSource: `Cost unavailable · no audited price for ${modelId}` };
  }
  const rateSet = applicableRates(pricing, at);
  if (!rateSet) {
    return { costSource: `Cost unavailable · no effective price for ${modelId}` };
  }

  const requests = requestUsages?.length ? requestUsages : [usage];
  let costUsd = 0;
  for (const requestUsage of requests) {
    const requestCost = estimateRequestCost(requestUsage, rateSet, inputAccounting);
    if (requestCost === undefined) {
      return { costSource: "Cost unavailable · inconsistent provider token buckets" };
    }
    costUsd += requestCost;
  }

  const note = pricing.note ? ` · ${pricing.note}` : "";
  return {
    costUsd,
    costSource: `Estimated token cost · ${pricing.provider} list rates · audited ${PRICE_CATALOG_ACCESSED_ON}${note}`,
  };
}
