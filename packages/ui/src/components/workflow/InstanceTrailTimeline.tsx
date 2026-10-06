// OPR.0.4.6.WF4 (C4) — the routing-history timeline (the FR-2 trail surface).
//
// The append-only step trail as a glanceable path (Temporal's event-group
// discipline — grouped, status-colored, never a raw log dump), each row drills
// in to its actor + closure evidence + packet lineage. The live frontier step
// rides as a dashed "open" row below the closed trail. `?step=<id>` deep-links
// (FR-3) auto-expand the matching trail row, or highlight the frontier when the
// anchor IS the current step.

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import type {
  WorkflowInstanceWithDeadline,
  WorkflowStepTrailEntry,
} from "../../hooks/useWorkflow.js";
import { DisplayTime } from "../time/DisplayTime.js";

const EXIT_GLYPH: Record<string, { glyph: string; cls: string }> = {
  handoff: { glyph: "→", cls: "text-emerald-800" },
  waiting: { glyph: "◐", cls: "text-on-surface-variant" },
  done: { glyph: "○", cls: "text-on-surface-variant" },
  failed: { glyph: "▲", cls: "text-red-700" },
};

function TrailRow({
  entry,
  index,
  expanded,
  onToggle,
}: {
  entry: WorkflowStepTrailEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const exit = EXIT_GLYPH[entry.closureReason] ?? { glyph: "?", cls: "text-on-surface-variant" };
  const note =
    entry.closureEvidence && typeof entry.closureEvidence.resultNote === "string"
      ? entry.closureEvidence.resultNote
      : null;
  return (
    <li id={`step-${entry.stepId}`}>
      <button
        type="button"
        data-testid={`workflow-trail-row-${entry.trailId}`}
        onClick={onToggle}
        // Narrow: a stacked grid (index · step · time / role · exit / note)
        // instead of squeezing fixed columns; from sm the single dense row.
        // Ids wrap anywhere rather than overflow; their text is unchanged.
        className="touch-target grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 px-2 py-1.5 text-left hover:bg-surface-variant/50 sm:flex sm:items-center"
      >
        <span className="font-mono text-[10px] text-on-surface-variant sm:w-6 sm:shrink-0">{index + 1}.</span>
        <span className="min-w-0 font-mono text-[11px] font-bold text-on-surface [overflow-wrap:anywhere] sm:w-28 sm:shrink-0">{entry.stepId}</span>
        <span className="col-start-2 row-start-2 min-w-0 font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere] sm:w-20 sm:shrink-0">{entry.stepRole}</span>
        <span className={cn("col-start-3 row-start-2 font-mono text-[11px] sm:w-20 sm:shrink-0", exit.cls)}>
          {exit.glyph} {entry.closureReason}
        </span>
        <span className="col-span-2 col-start-2 min-w-0 truncate text-[11px] text-on-surface-variant sm:flex-1">{note ?? "—"}</span>
        <span className="hidden font-mono text-[10px] text-on-surface-variant lg:inline">{entry.actorSession}</span>
        <span className="col-start-3 row-start-1 font-mono text-[10px] text-on-surface-variant"><DisplayTime iso={entry.closedAt} className="" /></span>
      </button>
      {expanded ? (
        <div
          data-testid={`workflow-trail-expanded-${entry.trailId}`}
          className="space-y-1 border-t border-outline-variant/50 bg-surface-lowest/10 px-3 py-2 font-mono text-[10px] [overflow-wrap:anywhere] sm:px-8"
        >
          <p>
            <span className="uppercase text-on-surface-variant">actor: </span>
            {entry.actorSession}
          </p>
          <p>
            <span className="uppercase text-on-surface-variant">closed packet: </span>
            {entry.priorQitemId}
          </p>
          <p>
            <span className="uppercase text-on-surface-variant">routed next: </span>
            {entry.nextQitemId ?? "(terminal — no next packet)"}
          </p>
          {entry.closureEvidence ? (
            <pre className="overflow-x-auto border border-outline-variant/40 bg-surface-lowest/20 p-2 text-[9px] leading-snug">
              {JSON.stringify(entry.closureEvidence, null, 2)}
            </pre>
          ) : (
            <p className="text-on-surface-variant">(no closure evidence recorded)</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function InstanceTrailTimeline({
  trail,
  instance,
  anchorStepId,
}: {
  trail: WorkflowStepTrailEntry[];
  instance: WorkflowInstanceWithDeadline;
  /** `?step=<id>` deep-link target: auto-expand the matching closed row. */
  anchorStepId?: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(() => {
    if (!anchorStepId) return null;
    const hit = trail.find((t) => t.stepId === anchorStepId);
    return hit ? hit.trailId : null;
  });

  const frontierAnchored = anchorStepId != null && anchorStepId === instance.currentStepId;

  return (
    <div className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
        Routing History
        <span className="ml-2 normal-case tracking-normal">
          {trail.length} closed step{trail.length === 1 ? "" : "s"} · append-only trail · deterministic path
          {instance.currentStepId ? ` → now at ${instance.currentStepId}` : ""}
        </span>
      </div>
      {trail.length === 0 ? (
        <p className="font-mono text-[11px] text-on-surface-variant">
          No steps closed yet — the entry packet is on the frontier.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
          {trail.map((entry, i) => (
            <TrailRow
              key={entry.trailId}
              entry={entry}
              index={i}
              expanded={expanded === entry.trailId}
              onToggle={() => setExpanded((cur) => (cur === entry.trailId ? null : entry.trailId))}
            />
          ))}
        </ul>
      )}
      {instance.currentStepId ? (
        <div
          id={`step-${instance.currentStepId}`}
          data-testid="workflow-frontier-row"
          className={cn(
            "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 border border-dashed px-2 py-1.5 sm:flex sm:items-center",
            frontierAnchored ? "border-amber-700 bg-amber-700/5" : "border-outline-variant",
          )}
        >
          <span className="font-mono text-[10px] text-on-surface-variant sm:w-6 sm:shrink-0">{trail.length + 1}.</span>
          <span className="min-w-0 font-mono text-[11px] font-bold text-on-surface [overflow-wrap:anywhere] sm:w-28 sm:shrink-0">
            {instance.currentStepId}
          </span>
          <span className="font-mono text-[11px] text-emerald-800 sm:w-20 sm:shrink-0">● open</span>
          {/* Narrow: the frontier packet id wraps whole on its own line; sm+ truncates in the row. */}
          <span className="col-span-2 col-start-2 min-w-0 font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere] sm:flex-1 sm:truncate">
            frontier packet {instance.currentFrontier[0] ?? "(none)"}
            {instance.deadline.evidence ? ` · held by ${instance.deadline.evidence.ownerSession}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}
