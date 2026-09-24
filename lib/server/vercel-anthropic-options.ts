import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";

const adaptiveEffortModels = new Set(["claude-opus-5", "claude-sonnet-5"]);

export function vercelAnthropicProviderOptions(
  model: string,
) {
  if (adaptiveEffortModels.has(model)) {
    return {
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
    } satisfies AnthropicLanguageModelOptions;
  }

  return {
    thinking: {
      type: "enabled",
      budgetTokens: 1_024,
    },
  } satisfies AnthropicLanguageModelOptions;
}
