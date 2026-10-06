// Compact selection card for a small stacked stage (phone portrait or
// landscape). It sits OUTSIDE the 3D scene, under the stage, so nothing in
// the scene is covered. The summary is enough to know which seat is
// selected (exact name, rig / pod, status as shape AND text, problem count)
// with Open seat and Focus; Details discloses the full inspector body
// (evidence, problems, runtime, session, work, relationships). Read-only:
// no mutation, no terminal.

import { ArrowUpRight, ChevronDown, Crosshair } from "lucide-react";
import { useId } from "react";
import type { SpatialAgent, SpatialModel, SpatialSeatStatus } from "../../../lib/spatial-topology.js";
import type { TopologyScope } from "../../../lib/topology-location.js";
import { cn } from "../../../lib/utils.js";
import { TopologyLink, topologyTarget } from "../topology-navigation.js";
import { SpatialInspector } from "./SpatialInspector.js";
import { hslCss, type SpatialPalette } from "./spatial-palette.js";

export interface SpatialSelectionCardProps {
  model: SpatialModel;
  agent: SpatialAgent | null;
  status: SpatialSeatStatus | null;
  palette: SpatialPalette;
  canFocus: boolean;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  onSelect: (key: string) => void;
  onFocus: (key: string) => void;
  linkSource?: string | null;
  from?: TopologyScope | null;
}

export function SpatialSelectionCard({
  model, agent, status, palette, canFocus, detailsOpen, onDetailsOpenChange, onSelect, onFocus, linkSource = null, from = null,
}: SpatialSelectionCardProps) {
  const detailId = useId();
  if (!agent || !status) {
    return (
      <p data-testid="spatial-selection-card-empty" className="px-3 py-2.5 font-mono text-[10px] leading-relaxed text-on-surface-variant">
        Tap a seat to see it here, or choose one in the seat index below. Drag to orbit · pinch to zoom · two fingers to pan.
      </p>
    );
  }
  const tone = hslCss(palette.tones[status.tone]);
  const problems = status.problems.length;
  return (
    <section data-testid="spatial-selection-card" aria-label={`Selected seat ${agent.displayName}`} className="px-3 pb-1 pt-2.5">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          data-tone={status.tone}
          className={cn("spatial-mark mt-1.5", status.stale && "is-stale")}
          style={{ "--spatial-tone": tone } as React.CSSProperties}
        />
        <div className="min-w-0 flex-1">
          <h3 data-testid="spatial-card-name" className="break-words font-headline text-base font-bold leading-tight text-on-surface">
            {agent.displayName}
          </h3>
          <p data-testid="spatial-card-context" className="mt-0.5 break-words font-mono text-[10px] text-on-surface-variant">
            {agent.rigName} / {agent.podNamespace ?? "no pod"} ·{" "}
            <span data-testid="spatial-card-status" className="text-on-surface">{status.label}</span>
            {status.stale ? " · stale sample" : ""}
            {problems > 0 ? <span className="text-tertiary"> · {problems} problem{problems === 1 ? "" : "s"}</span> : null}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="spatial-card-details"
          aria-expanded={detailsOpen}
          aria-controls={detailId}
          onClick={() => onDetailsOpenChange(!detailsOpen)}
          className="spatial-hud-button touch-target !h-8 !px-3"
        >
          Details
          <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform motion-reduce:transition-none", detailsOpen && "rotate-180")} />
        </button>
        <button
          type="button"
          data-testid="spatial-focus-seat"
          disabled={!canFocus}
          onClick={() => onFocus(agent.key)}
          className="spatial-hud-button touch-target !h-8 !px-3"
        >
          <Crosshair aria-hidden="true" className="h-3.5 w-3.5" /> Focus
        </button>
        {agent.logicalId ? (
          // Exact logical id from the selected graph entry, as in the inspector.
          <TopologyLink
            data-testid="spatial-open-seat"
            target={topologyTarget({ scope: { kind: "seat", rigId: agent.rigId, logicalId: agent.logicalId }, sourceHost: linkSource })}
            from={from}
            unavailableTitle="This seat's identity cannot be represented in a link."
            className="spatial-hud-button touch-target !h-8 !px-3"
          >
            Open seat <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </TopologyLink>
        ) : (
          <span className="self-center font-mono text-[10px] italic text-on-surface-variant">No logical id: detail unavailable.</span>
        )}
      </div>
      <div id={detailId} data-testid={detailsOpen ? "spatial-card-detail" : undefined} hidden={!detailsOpen}>
        {detailsOpen ? (
          <SpatialInspector
            model={model}
            agent={agent}
            status={status}
            palette={palette}
            canFocus={canFocus}
            onSelect={onSelect}
            onFocus={onFocus}
            linkSource={linkSource}
            from={from}
            hideSummary
          />
        ) : null}
      </div>
    </section>
  );
}
