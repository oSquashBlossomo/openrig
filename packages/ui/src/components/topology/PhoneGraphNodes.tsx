// Node renderers for the phone 2D topology graph (PhoneTopologyGraph).
// Compact, fixed-size and legible at the opening zoom; state is carried as
// text (status label, counts) as well as colour. A tap on any node only
// selects it — drilling is always an explicit action in the details panel,
// so a pan that ends on a node can never navigate.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SpatialTone } from "../../lib/spatial-topology.js";
import {
  tallyEntries,
  type PhonePodNodeData,
  type PhoneRigNodeData,
  type PhoneSeatNodeData,
  type PhoneTally,
  type PhoneTruncatedNodeData,
} from "../../lib/phone-graph-layout.js";
import { cn } from "../../lib/utils.js";

/** Per-render presentation added by PhoneTopologyGraph. */
export interface PhoneNodeView {
  selected?: boolean;
  /** Something else is selected and this node is not related to it. */
  dimmed?: boolean;
  onToggle?: () => void;
}

export const PHONE_TONE_LABEL: Record<SpatialTone, string> = {
  active: "active",
  needs_input: "needs input",
  blocked: "blocked",
  idle: "idle",
  unknown: "unknown",
  offline: "offline",
};

export const PHONE_TONE_DOT: Record<SpatialTone, string> = {
  active: "bg-emerald-500 border-emerald-600",
  needs_input: "bg-amber-400 border-amber-600",
  blocked: "bg-error border-error",
  idle: "bg-stone-300 border-stone-500",
  unknown: "bg-transparent border-dashed border-stone-500",
  offline: "bg-transparent border-stone-500",
};

export function ToneDot({ tone, className }: { tone: SpatialTone; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full border", PHONE_TONE_DOT[tone], className)} />;
}

/** `fit`: one line inside a fixed-height node row. Past three tones the
 *  labels collapse to dot + count (full text in the title and for screen
 *  readers) instead of wrapping into a second line the node would clip. */
export function TallyRow({ tally, className, fit = false }: { tally: PhoneTally; className?: string; fit?: boolean }) {
  const entries = tallyEntries(tally);
  if (entries.length === 0) return <span className={cn("text-on-surface-variant", className)}>no seats</span>;
  const dense = fit && entries.length > 3;
  return (
    <span
      className={cn("inline-flex items-center gap-x-2", fit ? "max-w-full flex-nowrap overflow-hidden" : "flex-wrap gap-y-0.5", className)}
      title={dense ? entries.map(([tone, n]) => `${n} ${PHONE_TONE_LABEL[tone]}`).join(" · ") : undefined}
    >
      {entries.map(([tone, n]) => (
        <span key={tone} className="inline-flex shrink-0 items-center gap-1" data-tone={tone}>
          <ToneDot tone={tone} />
          {n}{dense ? <span className="sr-only"> {PHONE_TONE_LABEL[tone]}</span> : ` ${PHONE_TONE_LABEL[tone]}`}
        </span>
      ))}
    </span>
  );
}

const HIDDEN_HANDLE = "!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent opacity-0";

/** Four in/out anchors; the layout picks the pair facing the other end. */
function Anchors() {
  return (
    <>
      <Handle id="t-top" type="target" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="t-bottom" type="target" position={Position.Bottom} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="t-left" type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="t-right" type="target" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="s-top" type="source" position={Position.Top} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="s-bottom" type="source" position={Position.Bottom} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="s-left" type="source" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
      <Handle id="s-right" type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
    </>
  );
}

function ToggleButton({ expanded, label, onToggle, testId }: { expanded: boolean; label: string; onToggle?: () => void; testId: string }) {
  if (!onToggle) return null;
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      // Own the tap: toggling must not also count as a node tap.
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="nodrag nopan inline-flex h-11 w-11 shrink-0 items-center justify-center text-on-surface hover:bg-surface-low/70"
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

export function PhoneRigNode({ data }: NodeProps) {
  const d = data as unknown as PhoneRigNodeData & PhoneNodeView;
  const name = d.rigName || d.rigId;
  return (
    <div
      data-testid="phone-graph-rig"
      data-rig-id={d.rigId}
      data-state={d.state}
      data-expanded={d.expanded ? "true" : "false"}
      data-selected={d.selected ? "true" : "false"}
      className={cn(
        "h-full w-full border bg-surface-lowest/70 font-mono transition-opacity",
        d.state === "error" ? "border-error/70" : "border-outline-variant",
        d.selected && "ring-2 ring-primary",
        d.dimmed && "opacity-40",
      )}
    >
      <Anchors />
      <div className="flex h-12 items-center gap-1 border-b border-outline-variant/60 pl-3 pr-0.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold leading-tight text-on-surface">{name}</div>
          <div className="truncate text-[10px] leading-tight text-on-surface-variant">
            {d.qualifier ? <span>{d.qualifier} · </span> : null}
            {d.state === "ready"
              ? `${d.seatCount} seat${d.seatCount === 1 ? "" : "s"} · ${d.podCount} pod${d.podCount === 1 ? "" : "s"}`
              : d.state === "loading" ? "reading graph…" : "graph unavailable"}
            {d.issueCount > 0 ? ` · ${d.issueCount} skipped` : ""}
          </div>
        </div>
        {d.collapsible ? <ToggleButton expanded={d.expanded} label={`rig ${name}`} onToggle={d.onToggle} testId="phone-graph-rig-toggle" /> : null}
      </div>
      {!d.expanded ? (
        <div className="flex h-7 items-center px-3 text-[10px] text-on-surface-variant">
          {d.state === "error" ? (
            <span className="truncate text-error" data-testid="phone-graph-rig-error">{d.message}</span>
          ) : d.state === "loading" ? (
            <span>waiting for this rig&apos;s graph</span>
          ) : (
            <TallyRow tally={d.tally} fit />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PhonePodNode({ data }: NodeProps) {
  const d = data as unknown as PhonePodNodeData & PhoneNodeView;
  return (
    <div
      data-testid="phone-graph-pod"
      data-pod-key={d.podKey}
      data-expanded={d.expanded ? "true" : "false"}
      data-selected={d.selected ? "true" : "false"}
      className={cn(
        "h-full w-full border font-mono transition-opacity",
        d.loose ? "border-dashed border-outline-variant/70 bg-transparent" : "border-outline-variant/80 bg-surface-low/40",
        d.selected && "ring-2 ring-primary",
        d.dimmed && "opacity-40",
      )}
    >
      <Anchors />
      <div className="flex h-11 items-center gap-1 pl-2.5 pr-0.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-bold leading-tight text-on-surface">
            {d.label}
            {d.loose ? null : <span className="font-normal text-on-surface-variant"> pod</span>}
          </div>
          <div className="truncate text-[10px] leading-tight text-on-surface-variant">
            {d.expanded ? `${d.seatCount} seat${d.seatCount === 1 ? "" : "s"}` : <TallyRow tally={d.tally} fit />}
          </div>
        </div>
        {d.loose ? null : <ToggleButton expanded={d.expanded} label={`pod ${d.label}`} onToggle={d.onToggle} testId="phone-graph-pod-toggle" />}
      </div>
    </div>
  );
}

export function PhoneSeatNode({ data }: NodeProps) {
  const d = data as unknown as PhoneSeatNodeData & PhoneNodeView;
  return (
    <div
      data-testid="phone-graph-seat"
      data-agent-key={d.agentKey}
      data-tone={d.tone}
      data-selected={d.selected ? "true" : "false"}
      className={cn(
        "flex h-full w-full flex-col justify-center gap-0.5 border bg-background px-2 font-mono shadow-[1px_1px_0_rgba(46,52,46,0.10)] transition-opacity",
        d.problem ? "border-error/70" : "border-outline-variant",
        d.selected && "border-primary ring-2 ring-primary",
        d.dimmed && "opacity-35",
      )}
    >
      <Anchors />
      <div className="flex min-w-0 items-center gap-1.5">
        <ToneDot tone={d.tone} className={d.stale ? "opacity-50" : undefined} />
        <span className="truncate text-[12px] font-bold leading-tight text-on-surface">{d.label}</span>
      </div>
      <div className="truncate pl-4 text-[9.5px] leading-tight text-on-surface-variant">
        {d.qualifier ? `${d.qualifier} · ` : ""}
        {d.statusLabel}
        {d.problem ? " · !" : ""}
      </div>
    </div>
  );
}

export function PhoneTruncatedNode({ data }: NodeProps) {
  const d = data as unknown as PhoneTruncatedNodeData;
  return (
    <div
      data-testid="phone-graph-truncated"
      className="flex h-full w-full flex-col justify-center border border-dashed border-outline-variant px-3 font-mono text-[11px] text-on-surface-variant"
    >
      <span className="font-bold text-on-surface">+{d.count} more rig{d.count === 1 ? "" : "s"}</span>
      <span className="text-[10px]">not drawn here (bounded reads) — listed in Table</span>
    </div>
  );
}
