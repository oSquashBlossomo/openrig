/** Browser-safe projection shared by preflight and the staged TTY proof. */
export interface NativeChatComposerSize { columns: number; rows: number }
export const NATIVE_CHAT_COMPOSER_REFUSAL = "This message cannot be verified in the native composer. Shorten it or use Terminal.";

export function projectNativeChatText(text: string, size: NativeChatComposerSize, runtime: "codex" | "claude-code", width: (text: string) => number): string[] | null {
  const { columns: capacity, rows } = size;
  // Claude Code 2.1.302 collapses single-line bracketed pastes above 800 UTF-16 units.
  if (runtime === "claude-code" && text.length > 800) return null;
  if (/[\r\n]/.test(text) || capacity <= 0 || rows <= 0 || width(text) > capacity * rows + rows - 1) return null;
  let remaining = text;
  const projected: string[] = [];
  while (width(remaining) > capacity) {
    let split = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === " " && width(remaining.slice(0, i)) <= capacity) split = i;
      if (width(remaining.slice(0, i + 1)) > capacity) break;
    }
    // Only one space at a demonstrated native word-wrap boundary may disappear.
    if (split <= 0 || remaining[split - 1] === " " || remaining[split + 1] === " ") return null;
    projected.push(remaining.slice(0, split));
    remaining = remaining.slice(split + (split < remaining.length - 1 ? 1 : 0));
    if (projected.length >= rows) return null;
  }
  projected.push(remaining);
  // Codex reserves an insertion row for a full final line.
  if (runtime === "codex" && width(remaining) === capacity) projected.push("");
  return projected.length <= rows ? projected : null;
}
