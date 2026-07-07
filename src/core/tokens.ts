/** Fast token estimate (~4 chars/token) used for context-pack budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Trim text to approximately fit a token budget, cutting at a line boundary. */
export function clampToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = maxTokens * 4
  const clipped = text.slice(0, maxChars)
  const lastNewline = clipped.lastIndexOf('\n')
  const safe = lastNewline > maxChars * 0.5 ? clipped.slice(0, lastNewline) : clipped
  return `${safe}\n… [truncated to ~${maxTokens} tokens]`
}
