export function conciseEvaluationRationale(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "No rationale returned.";

  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  const words = firstSentence.split(" ");
  const concise = words.length > 18
    ? `${words.slice(0, 18).join(" ").replace(/[,;:]$/, "")}.`
    : firstSentence;

  return /[.!?]$/.test(concise) ? concise : `${concise}.`;
}
