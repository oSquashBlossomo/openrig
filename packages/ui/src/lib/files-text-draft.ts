/** Text serialization only. This grants no file-edit authority and never owns
 * CAS tokens; callers retain the original complete read and its safety checks. */
export type FileLineEnding = "lf" | "crlf" | "cr";
export interface FileLineEndingCounts { readonly lf: number; readonly crlf: number; readonly cr: number }
export interface FileTextAnalysis {
  readonly lfText: string;
  readonly ending: "none" | FileLineEnding | "mixed";
  readonly counts: FileLineEndingCounts;
}
export class FileTextSourceError extends Error {
  readonly code = "invalid_source";
  constructor() { super("File text source must be a valid Unicode string."); this.name = "FileTextSourceError"; }
}
export type PreparedFileTextWrite =
  | { kind: "ready"; content: string; dirty: boolean; handling: "unchanged" | "uniform" | "new-lines-lf" | "mixed-normalized" }
  | { kind: "mixed-policy-required"; counts: FileLineEndingCounts }
  | { kind: "invalid-draft"; reason: "invalid-source" | "not-lf-projection" | "invalid-unicode" | "invalid-choice" };

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** CRLF is one separator; other Unicode, whitespace and BOM remain exact. */
export function analyzeFileText(raw: string): FileTextAnalysis {
  if (typeof raw !== "string" || !validUnicode(raw)) throw new FileTextSourceError();
  const counts = { lf: 0, crlf: 0, cr: 0 };
  const lfText = raw.replace(/\r\n|\r|\n/g, separator => {
    counts[separator === "\r\n" ? "crlf" : separator === "\r" ? "cr" : "lf"]++;
    return "\n";
  });
  const present = (["lf", "crlf", "cr"] as const).filter(ending => counts[ending] > 0);
  return { lfText, ending: present.length === 0 ? "none" : present.length === 1 ? present[0]! : "mixed", counts };
}

const separators: Record<FileLineEnding, string> = { lf: "\n", crlf: "\r\n", cr: "\r" };

/** Prepare bytes from a textarea's complete LF value. Changed mixed text has
 * no inferable boundary provenance, so normalization requires an explicit
 * per-base user choice. This is not a Format Document operation. */
export function prepareFileTextWrite(baseRaw: string, nextLf: string, mixedEndingChoice?: FileLineEnding): PreparedFileTextWrite {
  let analysis: FileTextAnalysis;
  try { analysis = analyzeFileText(baseRaw); }
  catch { return { kind: "invalid-draft", reason: "invalid-source" }; }
  if (typeof nextLf !== "string" || nextLf.includes("\r")) return { kind: "invalid-draft", reason: "not-lf-projection" };
  if (!validUnicode(nextLf)) return { kind: "invalid-draft", reason: "invalid-unicode" };
  // Undo/cancel back to the original view restores ALL original bytes, even
  // with a retained choice. Selecting a format alone never makes a dirty file.
  if (nextLf === analysis.lfText) return { kind: "ready", content: baseRaw, dirty: false, handling: "unchanged" };
  if (mixedEndingChoice !== undefined && mixedEndingChoice !== "lf" && mixedEndingChoice !== "crlf" && mixedEndingChoice !== "cr") {
    return { kind: "invalid-draft", reason: "invalid-choice" };
  }
  if (analysis.ending === "mixed" && mixedEndingChoice === undefined) return { kind: "mixed-policy-required", counts: analysis.counts };
  const ending = analysis.ending === "mixed" ? mixedEndingChoice! : analysis.ending === "none" ? "lf" : analysis.ending;
  const content = nextLf.replace(/\n/g, separators[ending]);
  return { kind: "ready", content, dirty: content !== baseRaw,
    handling: analysis.ending === "mixed" ? "mixed-normalized" : analysis.ending === "none" ? "new-lines-lf" : "uniform" };
}
