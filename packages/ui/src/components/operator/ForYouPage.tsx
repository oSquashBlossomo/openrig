// For You — canonical Attention alongside the existing Activity feed.
//
// The selected view and the exact selected attention item ride the URL
// (?view=attention|activity&item=<canonical id>) so direct links, reload and
// Back restore them. The Activity feed is the unchanged Feed component with
// its own authorized action surfaces.

import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { Feed } from "../for-you/Feed.js";
import { AttentionView, type AttentionFilters } from "./AttentionView.js";
import { connectedInstanceLabel, useConnectedInstance } from "./OperatorPrimitives.js";
import { validateForYouSearch, type ForYouView } from "./operator-search.js";

const TABS: Array<{ id: ForYouView; label: string; hint: string }> = [
  { id: "attention", label: "Attention", hint: "Canonical requests & updates" },
  { id: "activity", label: "Activity", hint: "Live feed & actions" },
];

export function ForYouPage() {
  const search = validateForYouSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  const view: ForYouView = search.view ?? "attention";
  const instance = useConnectedInstance();
  const onFilters = useCallback((patch: AttentionFilters) => void navigate({
    to: "/for-you", search: (prev: Record<string, unknown>) => ({ ...validateForYouSearch(prev), ...patch }), replace: true,
  }), [navigate]);
  // Item selection is retained across tab switches so returning restores it.
  const select = (next: ForYouView) => { if (next !== view) void navigate({ to: "/for-you", search: { ...search, view: next } }); };

  return (
    <div data-testid="for-you-page" data-view={view}>
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6">
        <div
          role="tablist" aria-label="For You views" className="flex flex-wrap items-end gap-1 border-b border-outline-variant"
          onKeyDown={(event) => {
            // ARIA tabs: Left/Right/Home/End move between views.
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = TABS.findIndex((tab) => tab.id === view);
            const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
            select(TABS[next]!.id);
            document.getElementById(`for-you-tab-${TABS[next]!.id}`)?.focus();
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`for-you-tab-${tab.id}`}
              aria-selected={view === tab.id}
              aria-controls={`for-you-panel-${tab.id}`}
              tabIndex={view === tab.id ? 0 : -1}
              data-testid={`for-you-tab-${tab.id}`}
              onClick={() => select(tab.id)}
              className={cn(
                "-mb-px border border-b-0 px-3 py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
                view === tab.id ? "border-on-surface bg-surface-lowest" : "border-transparent text-on-surface-variant hover:text-on-surface",
              )}
            >
              <span className="block font-mono text-[11px] font-bold uppercase tracking-[0.12em]">{tab.label}</span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">{tab.hint}</span>
            </button>
          ))}
          {view === "attention" ? (
            <span data-testid="operator-instance-label" className="ml-auto pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
              {connectedInstanceLabel(instance)}
            </span>
          ) : null}
        </div>
      </div>
      <div role="tabpanel" id={`for-you-panel-${view}`} aria-labelledby={`for-you-tab-${view}`}>
        {view === "activity" ? <Feed /> : (
          <div className="mx-auto w-full max-w-[1200px] px-4 py-4 sm:px-6">
            {instance.remoteSelection ? (
              <p data-testid="operator-remote-context" role="note" className="mb-3 max-w-[72ch] border-l-2 border-warning pl-2 text-xs text-on-surface-variant">
                Topology is viewing <span className="font-mono text-on-surface">{instance.remoteSelection}</span>. Canonical attention below still
                describes the connected instance; the Activity feed keeps its own host selection.
              </p>
            ) : null}
            <AttentionView
              selectedItem={search.item}
              // Selection pushes history; lens/search edits replace it. Both merge
              // into the current URL state rather than a render-time snapshot.
              onSelect={(item) => void navigate({ to: "/for-you", search: (prev: Record<string, unknown>) => ({ ...validateForYouSearch(prev), view: "attention" as const, item }) })}
              filters={{ lens: search.lens, q: search.q }}
              onFilters={onFilters}
            />
          </div>
        )}
      </div>
    </div>
  );
}
