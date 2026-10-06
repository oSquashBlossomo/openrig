// Selected-seat inspector. Read-only: the only actions are detail navigation
// and camera focus. It never mounts or focuses a terminal and issues no
// mutations. It always renders from the CURRENT model entry for the selected
// key, so refreshed data (or the seat disappearing) is reflected immediately.

import { ArrowUpRight, Crosshair } from "lucide-react";
import type { SpatialAgent, SpatialModel, SpatialSeatStatus } from "../../../lib/spatial-topology.js";
import { formatRuntimeModel } from "../../../lib/runtime-brand.js";
import { shortQitemTail } from "../../../lib/activity-visuals.js";
import type { TopologyScope } from "../../../lib/topology-location.js";
import { cn } from "../../../lib/utils.js";
import { TopologyLink, topologyTarget } from "../topology-navigation.js";
import { hslCss, type SpatialPalette } from "./spatial-palette.js";

export interface SpatialInspectorProps {
  model: SpatialModel;
  agent: SpatialAgent | null;
  status: SpatialSeatStatus | null;
  palette: SpatialPalette;
  canFocus: boolean;
  onSelect: (key: string) => void;
  onFocus: (key: string) => void;
  /** Source host for new links (null = not yet confirmed: legacy link). */
  linkSource?: string | null;
  /** The scope being left by Open seat (its drafts commit first). */
  from?: TopologyScope | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-[11px] text-on-surface">{children}</dd>
    </div>
  );
}

export function SpatialInspector({ model, agent, status, palette, canFocus, onSelect, onFocus, linkSource = null, from = null }: SpatialInspectorProps) {
  if (!agent || !status) {
    return (
      <div data-testid="spatial-inspector-empty" className="px-4 py-4">
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Inspector</div>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-on-surface-variant">
          Select a seat in the scene or the index to read its state, evidence and relationships.
        </p>
      </div>
    );
  }

  const outgoing = model.edges.filter((e) => e.sourceKey === agent.key);
  const incoming = model.edges.filter((e) => e.targetKey === agent.key);
  const tone = hslCss(palette.tones[status.tone]);
  const contextKnown = typeof agent.contextUsedPercentage === "number";

  return (
    <section data-testid="spatial-inspector" aria-label={`Seat ${agent.displayName}`} className="px-4 py-4">
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
        {agent.rigName}
        {agent.podNamespace ? ` / ${agent.podNamespace}` : " / no pod"}
      </div>
      <h3
        data-testid="spatial-inspector-name"
        className="mt-1 break-words font-headline text-xl font-bold leading-tight text-on-surface"
      >
        {agent.displayName}
      </h3>
      <div className="mt-0.5 break-all font-mono text-[10px] text-on-surface-variant">
        {agent.logicalId ?? `node ${agent.nodeId} (no logical id)`}
      </div>

      <div
        data-testid="spatial-inspector-status"
        className="mt-3 flex items-start gap-2 border-l-2 py-1 pl-2"
        style={{ borderColor: tone }}
      >
        <span
          aria-hidden="true"
          className={cn("spatial-dot mt-1 shrink-0", status.stale && "is-stale")}
          style={{ "--spatial-tone": tone } as React.CSSProperties}
        />
        <div className="min-w-0 font-mono text-[11px]">
          <div className="text-on-surface">{status.label}</div>
          <div className="text-[10px] text-on-surface-variant">
            {status.live ? "current · " : "not live · "}
            {status.evidence}
            {status.sampleAge
              ? ` · sample ${status.sampleAge} old`
              : status.live
                ? " · sample time not reported"
                : ""}
          </div>
        </div>
      </div>

      {status.problems.length > 0 ? (
        <ul data-testid="spatial-inspector-problems" className="mt-2 space-y-1">
          {status.problems.map((problem) => (
            <li key={problem} className="spatial-problem px-2 py-1 font-mono text-[10px]">
              {problem}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="mt-3 border-t border-outline-variant pt-2">
        <Field label="Runtime">{agent.runtime || agent.model ? formatRuntimeModel(agent.runtime, agent.model) : "unknown"}</Field>
        {agent.role ? <Field label="Role">{agent.role}</Field> : null}
        <Field label="Session">{agent.canonicalSessionName ?? "none recorded"}</Field>
        <Field label="Session state">{agent.sessionStatus ?? "unknown"}</Field>
        <Field label="Startup">{agent.startupStatus ?? "unknown"}</Field>
        <Field label="Context">
          {contextKnown
            ? `${Math.round(agent.contextUsedPercentage!)}% used${agent.contextFresh ? "" : " · stale sample"}`
            : "unknown"}
        </Field>
        <Field label="Work">
          {agent.pendingWorkCount > 0
            ? `${agent.pendingWorkCount} pending`
            : agent.hasAssignedWork ? "assigned" : "none queued"}
        </Field>
      </dl>

      {agent.currentQitems.length > 0 ? (
        <div className="mt-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">In progress</div>
          <ul className="mt-1 space-y-1">
            {agent.currentQitems.slice(0, 3).map((q) => (
              <li key={q.qitemId} className="font-mono text-[10px] text-on-surface" title={q.qitemId}>
                <span className="text-on-surface-variant">…{shortQitemTail(q.qitemId)}</span> {q.bodyExcerpt}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 border-t border-outline-variant pt-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          Relationships · {outgoing.length} out · {incoming.length} in
        </div>
        {outgoing.length + incoming.length === 0 ? (
          <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">No recorded relationships.</p>
        ) : (
          <ul data-testid="spatial-inspector-relationships" className="mt-1 space-y-0.5">
            {[...outgoing.map((e) => ({ e, dir: "→", peer: e.targetKey })), ...incoming.map((e) => ({ e, dir: "←", peer: e.sourceKey }))].map(({ e, dir, peer }) => {
              const peerAgent = model.agentsByKey.get(peer);
              return (
                <li key={`${e.key}${dir}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(peer)}
                    className="flex w-full min-w-0 items-baseline gap-2 py-0.5 text-left font-mono text-[10px] text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
                  >
                    <span aria-hidden="true" className="text-on-surface-variant">{dir}</span>
                    <span className="shrink-0 text-on-surface-variant">{e.kind}</span>
                    <span className="min-w-0 truncate">{peerAgent?.displayName ?? "unknown seat"}</span>
                    {e.crossPod ? <span className="shrink-0 text-[9px] text-on-surface-variant">cross-pod</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {agent.logicalId ? (
          // Exact logical id from the selected graph entry (never the graph
          // node id or a label); raw params, encoded once by the router.
          <TopologyLink
            data-testid="spatial-open-seat"
            target={topologyTarget({ scope: { kind: "seat", rigId: agent.rigId, logicalId: agent.logicalId }, sourceHost: linkSource })}
            from={from}
            unavailableTitle="This seat's identity cannot be represented in a link."
            className="spatial-hud-button !h-8 !px-3"
          >
            Open seat <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </TopologyLink>
        ) : (
          <span className="font-mono text-[10px] italic text-on-surface-variant">
            Detail unavailable: the graph entry has no logical id.
          </span>
        )}
        <button
          type="button"
          data-testid="spatial-focus-seat"
          disabled={!canFocus}
          onClick={() => onFocus(agent.key)}
          className="spatial-hud-button !h-8 !px-3"
        >
          <Crosshair aria-hidden="true" className="h-3.5 w-3.5" /> Focus
        </button>
      </div>
    </section>
  );
}
