// `/pulse` — Pulse, Recent and the maintained stream for the CONNECTED
// instance. Queue and stream reads are not forwarded to remote hosts, so a
// remote topology selection never retargets or relabels this page.
//
// URL state (raw publicHref; see recent-pulse-location.ts): view, exact rig,
// window, selected transition, opened qitem, stream filters/cursor and item.
// Selections and cursor pages push history (Back returns); tab, filter and
// window changes replace the current entry.

import { useCallback, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope } from "../../lib/operator-read.js";
import { cn } from "../../lib/utils.js";
import { DisplayZoneNote } from "../time/DisplayTime.js";
import { connectedInstanceLabel, useConnectedInstance } from "../operator/OperatorPrimitives.js";
import { SectionHeader } from "../ui/section-header.js";
import { PulseView } from "./PulseView.js";
import { QitemEvidence } from "./QitemEvidence.js";
import { useRecentView } from "./RecentView.js";
import { useStreamView } from "./StreamView.js";
import {
  RECENT_PULSE_VIEWS, parseRecentPulseLocation, rawQueryOf, recentPulseHref,
  type RecentPulseLocation, type RecentPulseLocationInput, type RecentPulseView,
} from "./recent-pulse-location.js";

export type RecentPulseGo = (next: RecentPulseLocationInput, options?: { replace?: boolean }) => void;

/** Location from the entry's raw publicHref; navigation merges into it. */
export function useRecentPulseLocation(): { location: RecentPulseLocation; go: RecentPulseGo } {
  const router = useRouter();
  const publicHref = useRouterState({ select: (state) => (state.location as { publicHref?: string }).publicHref ?? state.location.href });
  const location = useMemo(() => parseRecentPulseLocation(rawQueryOf(publicHref)), [publicHref]);
  const go = useCallback<RecentPulseGo>((next, options) => {
    const current = parseRecentPulseLocation(rawQueryOf((router.state.location as { publicHref?: string }).publicHref ?? router.state.location.href));
    const href = recentPulseHref({ ...current, ...next, stream: { ...current.stream, ...next.stream } });
    if (options?.replace) router.history.replace(href);
    else router.history.push(href);
  }, [router]);
  return { location, go };
}

const TAB_LABEL: Record<RecentPulseView, string> = { pulse: "Pulse", recent: "Recent", stream: "Stream" };

function Tabs({ active, onSelect }: { active: RecentPulseView; onSelect: (view: RecentPulseView) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = RECENT_PULSE_VIEWS.indexOf(active);
    const next = event.key === "ArrowRight" ? (index + 1) % RECENT_PULSE_VIEWS.length : event.key === "ArrowLeft" ? (index + RECENT_PULSE_VIEWS.length - 1) % RECENT_PULSE_VIEWS.length
      : event.key === "Home" ? 0 : event.key === "End" ? RECENT_PULSE_VIEWS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(RECENT_PULSE_VIEWS[next]!);
    requestAnimationFrame(() => document.getElementById(`recent-pulse-tab-${RECENT_PULSE_VIEWS[next]}`)?.focus());
  };
  return (
    <div role="tablist" aria-label="Pulse, Recent and Stream" onKeyDown={onKeyDown} className="mb-4 flex gap-1 border-b border-outline-variant">
      {RECENT_PULSE_VIEWS.map((view) => (
        <button
          key={view}
          id={`recent-pulse-tab-${view}`}
          role="tab"
          type="button"
          aria-selected={active === view}
          aria-controls="recent-pulse-panel"
          tabIndex={active === view ? 0 : -1}
          data-testid={`recent-pulse-tab-${view}`}
          onClick={() => onSelect(view)}
          className={cn(
            "-mb-px border-b-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
            active === view ? "border-on-surface text-on-surface" : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          {TAB_LABEL[view]}
        </button>
      ))}
    </div>
  );
}

/** List/detail: full-width list until a detail is open; on narrow screens the
 * detail shows first with an explicit return, nothing essential hidden. */
function Split({ list, detail, onBack, backLabel }: { list: ReactNode; detail: ReactNode | null; onBack: () => void; backLabel: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4", detail && "lg:grid-cols-[minmax(20rem,30rem)_1fr]")}>
      <div className={cn("min-w-0", detail && "hidden lg:block")}>{list}</div>
      {detail ? (
        <div className="min-w-0">
          <button type="button" data-testid="recent-pulse-detail-back" onClick={onBack} className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant hover:text-on-surface lg:hidden">
            ← {backLabel}
          </button>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

export function RecentPulsePage({ location, go, scope = LOCAL_OPERATOR_INSTANCE }: { location: RecentPulseLocation; go: RecentPulseGo; scope?: OperatorInstanceScope }) {
  const instance = useConnectedInstance();
  const recent = useRecentView({ scope, location: location.view === "recent" ? location : { ...location, transition: null }, go, active: location.view === "recent" });
  const stream = useStreamView({ scope, location: location.view === "stream" ? location : { ...location, item: null }, go, active: location.view === "stream" });
  const qitemDetail = location.qitem !== null
    ? <QitemEvidence scope={scope} qitemId={location.qitem} context={location.view === "recent" && location.transition !== null ? `Opened from recorded transition #${location.transition}; Back returns to it.` : undefined} />
    : null;
  const body = location.view === "pulse"
    ? <Split list={<PulseView scope={scope} selectedQitem={location.qitem} onOpenQitem={(qitem) => go({ qitem })} compact={qitemDetail !== null} />} detail={qitemDetail} onBack={() => go({ qitem: null })} backLabel="Pulse" />
    : location.view === "recent"
      ? <Split list={recent.list} detail={qitemDetail ?? recent.detail} onBack={() => go(location.qitem !== null ? { qitem: null } : { transition: null })} backLabel={location.qitem !== null && location.transition !== null ? `Transition #${location.transition}` : "Recent"} />
      : <Split list={stream.list} detail={stream.detail} onBack={() => go({ item: null })} backLabel="Stream" />;
  return (
    <div data-testid="recent-pulse-page" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
      <header className="mb-4 border-b border-outline-variant pb-4">
        <SectionHeader tone="muted">Work · connected instance</SectionHeader>
        <h1 className="mt-1 font-headline text-headline-md font-bold uppercase tracking-tight text-on-surface">Pulse &amp; Recent</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-on-surface-variant">
          Who needs you, who is working, what is parked or blocked, recorded queue transitions, and the persisted maintained stream. Browsing changes nothing.
        </p>
        <p data-testid="recent-pulse-instance" className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">{connectedInstanceLabel(instance)}</p>
        <DisplayZoneNote testId="recent-pulse-display-zone" className="mt-1 font-mono text-[10px] text-on-surface-variant" />
        {instance.remoteSelection ? (
          <p data-testid="recent-pulse-remote-context" role="note" className="mt-2 max-w-[72ch] border-l-2 border-warning pl-2 text-xs text-on-surface-variant">
            Topology is viewing <span className="font-mono text-on-surface">{instance.remoteSelection}</span>. Queue and stream reads are not forwarded to remote hosts, so this page still describes the connected instance.
          </p>
        ) : null}
        {location.issues.length ? (
          <ul data-testid="recent-pulse-url-issues" role="note" className="mt-2 border-l-2 border-warning pl-2 text-xs text-on-surface-variant">
            {location.issues.map((issue) => <li key={issue}>Link value not applied: {issue}.</li>)}
          </ul>
        ) : null}
      </header>
      <Tabs active={location.view} onSelect={(view) => go({ view, transition: null, qitem: null, item: null }, { replace: true })} />
      <div id="recent-pulse-panel" role="tabpanel" aria-labelledby={`recent-pulse-tab-${location.view}`}>{body}</div>
    </div>
  );
}

/** Route component for `/pulse` (no validateSearch: raw identities). */
export function RecentPulseRoute() {
  const { location, go } = useRecentPulseLocation();
  return <RecentPulsePage location={location} go={go} />;
}
