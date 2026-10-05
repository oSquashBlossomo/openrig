// Partial-data disclosure for 2D graphs: skipped (malformed, duplicate or
// dangling) entries and unreadable rig graphs are reported, never silent.

export function GraphPartialNotice({
  issues,
  unavailable = [],
}: {
  issues: Array<{ detail: string }>;
  /** Rig graphs that could not be read (name + reason). */
  unavailable?: Array<{ rigName: string; message: string }>;
}) {
  if (issues.length === 0 && unavailable.length === 0) return null;
  return (
    <div data-testid="graph-partial" role="status" className="font-mono text-[10px] text-on-surface-variant">
      {unavailable.length > 0 ? (
        <div data-testid="graph-partial-unavailable" className="text-error">
          {unavailable.length} rig graph{unavailable.length === 1 ? "" : "s"} unavailable:{" "}
          {unavailable.slice(0, 6).map((u) => `${u.rigName} (${u.message})`).join(", ")}
          {unavailable.length > 6 ? ", …" : ""}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <details>
          <summary className="cursor-pointer">
            Partial graph: {issues.length} entr{issues.length === 1 ? "y" : "ies"} skipped (malformed, duplicate or dangling)
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {issues.slice(0, 12).map((issue, i) => (
              <li key={i}>{issue.detail}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
