// Seat index — the GPU-free, keyboard-accessible view of the same spatial
// model. Compact variant sits beside the 3D stage; the table variant is the
// full "List" alternative. Arrow keys move between seats (roving focus);
// Enter/Space selects. Selecting never opens or focuses a terminal.

import { useCallback, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { SpatialAgent, SpatialModel, SpatialRig, SpatialSeatStatus } from "../../../lib/spatial-topology.js";
import { formatRuntimeModel } from "../../../lib/runtime-brand.js";
import type { TopologyScope } from "../../../lib/topology-location.js";
import { cn } from "../../../lib/utils.js";
import { TopologyLink, topologyTarget } from "../topology-navigation.js";
import { hslCss, type SpatialPalette } from "./spatial-palette.js";

export interface SpatialNodeListProps {
  model: SpatialModel;
  statusByKey: ReadonlyMap<string, SpatialSeatStatus>;
  palette: SpatialPalette;
  selectedKey: string | null;
  /** null = no active search. */
  matchKeys: ReadonlySet<string> | null;
  variant: "compact" | "table";
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  /** Source host for drill links (null = not yet confirmed: legacy link). */
  linkSource?: string | null;
  /** The scope being left by a rig/pod drill. */
  from?: TopologyScope | null;
  /** Drill links keep the rich 3D view and the current Scene/List choice;
   *  the new scope starts with no search, no selection and a fitted camera. */
  spatialMode?: "scene" | "list";
}

const ROW_SELECTOR = "[data-spatial-agent-row]";

export function SpatialNodeList(props: SpatialNodeListProps) {
  const { model, matchKeys, variant } = props;

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(ROW_SELECTOR)) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    const index = rows.indexOf(target);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = rows[index + 1];
    else if (e.key === "ArrowUp") next = rows[index - 1];
    else if (e.key === "Home") next = rows[0];
    else if (e.key === "End") next = rows[rows.length - 1];
    else return;
    e.preventDefault();
    next?.focus();
  }, []);

  const visible = (agent: SpatialAgent) => matchKeys === null || matchKeys.has(agent.key);
  const visibleCount = matchKeys === null ? model.counts.agents : matchKeys.size;

  return (
    <div
      data-testid={`spatial-seat-index-${variant}`}
      className="min-w-0"
      onKeyDown={onKeyDown}
      onMouseLeave={() => props.onHover(null)}
    >
      {matchKeys !== null ? (
        <div
          data-testid="spatial-search-count"
          role="status"
          className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
        >
          {visibleCount === 0 ? "No seats match" : `${visibleCount} of ${model.counts.agents} seats match`}
        </div>
      ) : null}
      {model.rigs.map((rig) => (
        <RigSection key={rig.key} rig={rig} visible={visible} {...props} />
      ))}
    </div>
  );
}

function RigSection({
  rig,
  visible,
  ...props
}: SpatialNodeListProps & { rig: SpatialRig; visible: (agent: SpatialAgent) => boolean }) {
  const agentByKey = new Map(rig.agents.map((a) => [a.key, a]));
  const groups: Array<{ key: string; title: string; podName: string | null; agents: SpatialAgent[] }> = rig.pods.map((pod) => ({
    key: pod.key,
    title: pod.label,
    podName: pod.namespace,
    agents: pod.agentKeys.map((k) => agentByKey.get(k)).filter((a): a is SpatialAgent => Boolean(a)),
  }));
  if (rig.looseAgentKeys.length > 0) {
    groups.push({
      key: `${rig.key}#loose`,
      title: "no pod",
      podName: null,
      agents: rig.looseAgentKeys.map((k) => agentByKey.get(k)).filter((a): a is SpatialAgent => Boolean(a)),
    });
  }
  const searching = props.matchKeys !== null;
  const visibleGroups = groups
    .map((g) => ({ ...g, agents: g.agents.filter(visible) }))
    .filter((g) => !searching || g.agents.length > 0);
  if (searching && visibleGroups.length === 0) return null;

  return (
    <section data-testid="spatial-index-rig" aria-label={`Rig ${rig.rigName}`} className="border-b border-outline-variant last:border-b-0">
      <header className="flex items-baseline gap-2 px-3 pt-3 pb-1">
        <TopologyLink
          target={topologyTarget({ scope: { kind: "rig", rigId: rig.rigId }, sourceHost: props.linkSource ?? null, view: "spatial", spatialMode: props.spatialMode ?? "scene" })}
          from={props.from ?? null}
          className="min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-on-surface hover:underline"
          title={`Open rig ${rig.rigName}`}
        >
          {rig.rigName}
        </TopologyLink>
        <span className="shrink-0 font-mono text-[9px] text-on-surface-variant">
          {rig.agents.length} seat{rig.agents.length === 1 ? "" : "s"}
          {rig.summaryNodeCount !== null && rig.summaryNodeCount !== rig.agents.length
            ? ` · summary ${rig.summaryNodeCount}`
            : ""}
        </span>
      </header>
      {rig.agents.length === 0 ? (
        <p className="px-3 pb-3 font-mono text-[10px] italic text-on-surface-variant">No seats in this rig&apos;s graph.</p>
      ) : null}
      {visibleGroups.map((group) => (
        <div key={group.key} data-testid="spatial-index-pod" className="pb-1">
          <div className="flex items-center gap-1 px-3 pt-1.5 pb-0.5 font-mono text-[9px] lowercase tracking-[0.06em] text-on-surface-variant">
            {group.podName ? (
              <TopologyLink
                target={topologyTarget({ scope: { kind: "pod", rigId: rig.rigId, podName: group.podName }, sourceHost: props.linkSource ?? null, view: "spatial", spatialMode: props.spatialMode ?? "scene" })}
                from={props.from ?? null}
                className="hover:text-on-surface hover:underline"
                title={`Open pod ${group.title}`}
              >
                {group.title}
              </TopologyLink>
            ) : (
              <span>{group.title}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>{group.agents.length}</span>
          </div>
          {props.variant === "table" ? (
            <AgentTable agents={group.agents} {...props} />
          ) : (
            <ul className="min-w-0">
              {group.agents.map((agent) => (
                <li key={agent.key}>
                  <AgentRow agent={agent} {...props} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function AgentRow({ agent, ...props }: SpatialNodeListProps & { agent: SpatialAgent }) {
  const status = props.statusByKey.get(agent.key);
  const selected = props.selectedKey === agent.key;
  const tone = status ? hslCss(props.palette.tones[status.tone]) : undefined;
  return (
    <button
      type="button"
      data-spatial-agent-row=""
      data-testid="spatial-agent-row"
      data-spatial-key={agent.key}
      aria-pressed={selected}
      onClick={() => props.onSelect(agent.key)}
      onMouseEnter={() => props.onHover(agent.key)}
      onFocus={() => props.onHover(agent.key)}
      onBlur={() => props.onHover(null)}
      className="spatial-row"
    >
      <span
        aria-hidden="true"
        className={cn("spatial-dot", status?.stale && "is-stale")}
        style={{ "--spatial-tone": tone } as React.CSSProperties}
      />
      <span className="min-w-0">
        <span className="block truncate">{agent.displayName}</span>
        <span className="block truncate text-[9px] text-on-surface-variant">
          {status?.label ?? "unknown"}
          {status?.problems.length ? " · attention" : ""}
        </span>
      </span>
      {agent.pendingWorkCount > 0 ? (
        <span className="shrink-0 border border-outline-variant px-1 text-[9px] text-on-surface-variant" title="Pending queue items">
          {agent.pendingWorkCount} queued
        </span>
      ) : (
        <span aria-hidden="true" />
      )}
    </button>
  );
}

function AgentTable({ agents, ...props }: SpatialNodeListProps & { agents: SpatialAgent[] }) {
  return (
    <div className="min-w-0">
      <table className="w-full table-fixed border-collapse font-mono text-[11px]">
        <thead className="sr-only">
          <tr>
            <th scope="col">Seat</th>
            <th scope="col">Status</th>
            <th scope="col" className="hidden md:table-cell">Evidence</th>
            <th scope="col" className="hidden md:table-cell">Runtime</th>
            <th scope="col">Work</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const status = props.statusByKey.get(agent.key);
            const selected = props.selectedKey === agent.key;
            const tone = status ? hslCss(props.palette.tones[status.tone]) : undefined;
            return (
              <tr key={agent.key} className={cn("border-t border-outline-variant", selected && "bg-surface-high")}>
                <td className="w-[46%] p-0 md:w-[34%]">
                  <button
                    type="button"
                    data-spatial-agent-row=""
                    data-testid="spatial-agent-row"
                    data-spatial-key={agent.key}
                    aria-pressed={selected}
                    onClick={() => props.onSelect(agent.key)}
                    onMouseEnter={() => props.onHover(agent.key)}
                    onFocus={() => props.onHover(agent.key)}
                    onBlur={() => props.onHover(null)}
                    className="spatial-row"
                  >
                    <span
                      aria-hidden="true"
                      className={cn("spatial-dot", status?.stale && "is-stale")}
                      style={{ "--spatial-tone": tone } as React.CSSProperties}
                    />
                    <span className="min-w-0 truncate" title={agent.logicalId ?? agent.nodeId}>{agent.displayName}</span>
                    <ChevronRight aria-hidden="true" className="h-3 w-3 text-on-surface-variant" />
                  </button>
                </td>
                <td className="w-[34%] truncate px-2 text-on-surface md:w-[22%]">
                  {status?.label ?? "unknown"}
                  {status?.problems.length ? <span className="text-tertiary"> · attention</span> : null}
                </td>
                <td className="hidden w-[18%] truncate px-2 text-on-surface-variant md:table-cell">
                  {status?.evidence ?? "—"}
                  {status?.sampleAge && !status.live ? ` · ${status.sampleAge}` : ""}
                </td>
                <td className="hidden w-[16%] truncate px-2 text-on-surface-variant md:table-cell">
                  {agent.runtime || agent.model ? formatRuntimeModel(agent.runtime, agent.model) : "—"}
                </td>
                <td className="w-[20%] truncate px-2 text-on-surface-variant md:w-[10%]">
                  {agent.pendingWorkCount > 0 ? `${agent.pendingWorkCount} queued` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
