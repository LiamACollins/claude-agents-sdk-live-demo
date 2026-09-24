import "server-only";

const modelIds: Record<string, string> = {
  "Claude Haiku 4.5": "claude-haiku-4-5-20251001",
  "Claude Sonnet 5": "claude-sonnet-5",
  "Claude Opus 5": "claude-opus-5",
  "GPT-5.4 nano": "gpt-5.4-nano",
  "GPT-5.4 mini": "gpt-5.4-mini",
  "GPT-5.1": "gpt-5.1",
  "Gemini 3.1 Flash-Lite": "gemini-3.1-flash-lite",
  "Gemini 3.8 Flash": "gemini-3.8-flash",
  "Gemini 3.1 Pro": "gemini-3.1-pro-preview",
};

export function resolveModelId(label: string) {
  const id = modelIds[label];
  if (!id) throw new Error(`Unsupported model selection: ${label}`);
  return id;
}

export function anthropicApiKey() {
  const key = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY_FOR_AGENTS;
  if (!key) throw new Error("Anthropic API credentials are not configured.");
  return key;
}

export function openAiApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OpenAI API credentials are not configured.");
  return key;
}

export function geminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini API credentials are not configured.");
  return key;
}
