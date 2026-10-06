// Shared pieces for the Recent / Pulse / stream views: exact seat and rig
// pointers, the finite arrival flash, and read-completion disclosure.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { cn } from "../../lib/utils.js";
import { TopologyLink, topologyTarget } from "../topology/topology-navigation.js";
import { Timestamp } from "../operator/OperatorPrimitives.js";
import type { RigResolution, SeatResolution } from "./recent-pulse-model.js";

export const FLASH_MS = 1600;

/**
 * Keys that newly appeared since the previous served set, for one finite
 * highlight. The first served set never flashes, and each flash ends after
 * FLASH_MS. Motion is CSS-only (`motion-safe`); reduced-motion users get a
 * static "new" tag for the same bounded time instead of any animation.
 */
export function useArrivalFlash(keys: readonly string[] | null): ReadonlySet<string> {
  const previous = useRef<Set<string> | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys ? keys.join("\u0001") : null;
  useEffect(() => {
    if (!keys) return;
    const next = new Set(keys);
    const prior = previous.current;
    previous.current = next;
    if (!prior) return;
    const arrived = keys.filter((key) => !prior.has(key));
    if (arrived.length) setFlashing(new Set(arrived));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  // Every flash ends: the timer is owned by the flashing set itself, so a
  // later refresh cannot strand a highlight, and unmount clears it.
  useEffect(() => {
    if (!flashing.size) return;
    const timer = setTimeout(() => setFlashing(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashing]);
  return flashing;
}

export function flashClass(active: boolean): string {
  return cn("transition-colors duration-700 motion-reduce:transition-none", active && "bg-secondary/10");
}

export function NewTag({ active }: { active: boolean }) {
  return active ? <span data-testid="arrival-flash" className="ml-1 border border-secondary px-1 font-mono text-[9px] uppercase text-secondary">new</span> : null;
}

const seatTarget = (rigId: string, logicalId: string) => topologyTarget({ scope: { kind: "seat", rigId, logicalId }, sourceHost: LOCAL_HOST_ID });
const rigTarget = (rigId: string) => topologyTarget({ scope: { kind: "rig", rigId }, sourceHost: LOCAL_HOST_ID });

const linkClass = "underline decoration-dotted underline-offset-2 hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface";

/** A canonical session with its exact seat drill, or the pointer and why not. */
export function SeatPointer({ session, resolution, testId }: { session: string; resolution: SeatResolution; testId?: string }) {
  const pointer = <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{session}</span>;
  if (resolution.kind === "seat") {
    return (
      <TopologyLink target={seatTarget(resolution.rigId, resolution.logicalId)} from={null} className={linkClass} data-testid={testId} data-seat-link="true">
        {pointer}<span className="ml-1 text-[11px] text-on-surface-variant">seat {resolution.logicalId} · rig {resolution.rigName}</span>
      </TopologyLink>
    );
  }
  const why = resolution.kind === "human" ? "human seat (no topology seat)"
    : resolution.kind === "no-logical-id" ? `served in rig ${resolution.rigName} without a logical ID; not linked`
    : resolution.kind === "ambiguous" ? `${resolution.count} served seats share this session; not linked`
    : resolution.kind === "not-found" ? (resolution.inventoryComplete ? "not a seat in the served inventory" : "not in the served (incomplete) inventory")
    : resolution.reason;
  return <span data-testid={testId} data-seat-link="false">{pointer}<span className="ml-1 text-[11px] text-on-surface-variant">({why})</span></span>;
}

export function RigPointer({ rigName, resolution, testId }: { rigName: string; resolution: RigResolution; testId?: string }) {
  if (resolution.kind === "rig") {
    return <TopologyLink target={rigTarget(resolution.rigId)} from={null} className={linkClass} data-testid={testId} data-rig-link="true">{rigName}</TopologyLink>;
  }
  const why = resolution.kind === "ambiguous" ? `${resolution.count} served rigs share this name` : resolution.kind === "not-found" ? "not in the served rig inventory" : resolution.reason;
  return <span data-testid={testId} data-rig-link="false">{rigName} <span className="text-[11px] text-on-surface-variant">({why})</span></span>;
}

/** Client read-completion time: when this browser finished the read, not
 * when anything happened on the instance. */
export function ReadCompletion({ at, fetching, label = "Read completed", testId, children }: { at: number | null | undefined; fetching: boolean; label?: string; testId?: string; children?: ReactNode }) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">
      <span>{label} <Timestamp iso={at ? new Date(at).toISOString() : null} fallback="not yet" /></span>
      {fetching ? <span aria-live="polite" className="text-on-surface motion-safe:animate-pulse">Reading…</span> : null}
      {children}
    </div>
  );
}

/** Plain anchor pushed byte-for-byte through router history (exact raw
 * query; no search re-serialization). Modified clicks keep browser behavior. */
export function HistoryLink({ href, children, className, ...data }: { href: string; children: ReactNode; className?: string } & { [attribute: `data-${string}`]: string | boolean | undefined }) {
  const router = useRouter();
  return (
    <a
      href={router.history.createHref(href)}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.history.push(href);
      }}
      className={className}
      {...data}
    >
      {children}
    </a>
  );
}
