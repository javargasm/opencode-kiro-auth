// Output-token estimator used when Kiro's stream omits `outputTokens`
// in its usage event. We use the standard ~4-chars-per-token heuristic
// (Anthropic's own rough guidance) rather than a full BPE tokenizer,
// since this value only feeds cost reporting on the fallback path.

export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
