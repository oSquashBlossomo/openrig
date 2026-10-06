// Shared Back/Forward scroll continuity for the shell's scrolling workspace.
//
// TanStack Router stores scroll per history ENTRY (its own sessionStorage
// cache, keyed by the entry, never by draft/native/GPU state). Restoration is
// applied only when the history entry changes — a push starts at the top,
// Back/Forward return to where that entry was — and never on `replace`
// navigations (filter keystrokes, tab/selection replaces), which must keep
// the user's current scroll; a replaced entry keeps its saved scroll identity
// (logicalEntryScrollKey). Pages with their own retained scroll (spatial
// visit snapshots, recovery/catalog providers) keep owning theirs.

import type { ParsedLocation } from "@tanstack/react-router";
import { parseTopologySearch, stringifyTopologySearch } from "../../lib/topology-search.js";

export const CONTENT_SCROLL_ID = "content-area";

/** Returns the router `scrollRestoration` predicate; one per router instance. */
export function entryChangeScrollRestoration(): (opts: { location: ParsedLocation }) => boolean {
  let lastIndex: number | undefined;
  return ({ location }) => {
    const index = (location.state as { __TSR_index?: number } | undefined)?.__TSR_index;
    const changed = index === undefined || index !== lastIndex;
    lastIndex = index;
    return changed;
  };
}

const ALIAS_STORAGE_KEY = "openrig.scrollEntryAlias.v1";
const ALIAS_LIMIT = 300;

/**
 * Scroll-restoration key that follows the LOGICAL history entry.
 *
 * TanStack issues a fresh `__TSR_key` on every replace, and its scroll cache
 * is keyed by that value, so a filter replace orphaned the entry's saved
 * scroll and Back restored 0. A key first seen at the same `__TSR_index` as
 * the previously current key is a replacement of that entry and inherits its
 * logical id; any other unseen key (push, a new branch after Back) is a new
 * entry. Keys are unique, so indexes reused by a later branch never collide.
 * Aliases persist in sessionStorage (bounded) so reload keeps them. History
 * state itself (including openrigTopologyVisit) is never read or written.
 */
export function logicalEntryScrollKey(storage: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage()): (location: ParsedLocation) => string {
  let aliases: Array<[string, string]> = [];
  try { aliases = JSON.parse(storage?.getItem(ALIAS_STORAGE_KEY) ?? "[]"); if (!Array.isArray(aliases)) aliases = []; } catch { aliases = []; }
  const byKey = new Map<string, string>(aliases.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"));
  let last: { key: string; index: number | undefined } | null = null;
  const persist = () => {
    try { storage?.setItem(ALIAS_STORAGE_KEY, JSON.stringify([...byKey].slice(-ALIAS_LIMIT))); } catch { /* memory only */ }
  };
  return (location) => {
    const state = location.state as { __TSR_key?: string; __TSR_index?: number } | undefined;
    const key = state?.__TSR_key;
    if (!key) return location.href;
    let logical = byKey.get(key);
    if (logical === undefined) {
      logical = last && last.key !== key && last.index !== undefined && last.index === state?.__TSR_index
        ? byKey.get(last.key) ?? last.key
        : key;
      byKey.set(key, logical);
      if (byKey.size > ALIAS_LIMIT) byKey.delete(byKey.keys().next().value as string);
      persist();
    }
    last = { key, index: state?.__TSR_index };
    return logical;
  };
}

function safeSessionStorage(): Storage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

const MAIN_STORAGE_KEY = "openrig.mainScroll.v1";
const MAIN_LIMIT = 300;
const MAIN_SELECTOR = `[data-scroll-restoration-id="${CONTENT_SCROLL_ID}"]`;

/**
 * Synchronous, entry-correct capture of the workspace <main> offset.
 *
 * TanStack captures scroll through a trailing 100 ms throttle that keeps only
 * the FIRST event and resolves the history entry when it fires. An immediate
 * Back/Forward therefore lost (or misfiled) the offset of the entry being
 * left, and the later restore scrolled <main> to 0 — overwriting, e.g., a
 * spatial visit's own restored offset. This store records <main> on every
 * scroll event under the logical entry that is current at that moment, and
 * re-applies it right after TanStack's restore whenever the entry changes
 * (Back/Forward/push), never on replaces. A fresh entry has no record, so a
 * push still starts at the top. Page owners that restore later from their
 * own per-visit snapshot (spatial) write the same entry's value.
 */
export function createMainScrollStore(storage: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage()) {
  let entries: Array<[string, number]> = [];
  try { entries = JSON.parse(storage?.getItem(MAIN_STORAGE_KEY) ?? "[]"); if (!Array.isArray(entries)) entries = []; } catch { entries = []; }
  const byEntry = new Map<string, number>(entries.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && Number.isFinite(pair[1])));
  let current: string | null = null;
  const persist = () => {
    try { storage?.setItem(MAIN_STORAGE_KEY, JSON.stringify([...byEntry].slice(-MAIN_LIMIT))); } catch { /* memory only */ }
  };
  return {
    /** The logical entry whose DOM is current (set when the router resolves it). */
    setCurrent(entry: string) { current = entry; },
    get current() { return current; },
    record(top: number) {
      if (current === null || !Number.isFinite(top)) return;
      byEntry.delete(current);
      byEntry.set(current, top);
      if (byEntry.size > MAIN_LIMIT) byEntry.delete(byEntry.keys().next().value as string);
      persist();
    },
    get(entry: string): number | undefined { return byEntry.get(entry); },
  };
}
type MainScrollStore = ReturnType<typeof createMainScrollStore>;

// One capture listener per document, bound to the most recently created
// router options (an app has one router; tests create one per mount).
let activeMainStore: MainScrollStore | null = null;
let captureInstalled = false;
function installMainCapture(store: MainScrollStore) {
  activeMainStore = store;
  if (captureInstalled || typeof document === "undefined") return;
  captureInstalled = true;
  document.addEventListener("scroll", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(MAIN_SELECTOR)) activeMainStore?.record(target.scrollTop);
  }, true);
}

/** Router options shared by the app router and the twin router: topology/** Router options shared by the app router and the twin router: topology
 * raw-search adapters (spatial cohort, b94bbd71) and scroll continuity. */
export function shellRouterOptions() {
  const entryKey = logicalEntryScrollKey();
  const entryChanged = entryChangeScrollRestoration();
  const main = createMainScrollStore();
  installMainCapture(main);
  return {
    parseSearch: parseTopologySearch,
    stringifySearch: stringifyTopologySearch,
    // Called by the router's onRendered handler immediately before it restores.
    scrollRestoration: ({ location }: { location: ParsedLocation }) => {
      const changed = entryChanged({ location });
      if (changed) {
        const entry = entryKey(location);
        main.setCurrent(entry);
        const saved = main.get(entry);
        // After the router's synchronous restore, re-apply this entry's own
        // captured <main> offset (none for a fresh push → top stays).
        if (saved !== undefined) queueMicrotask(() => {
          if (main.current !== entry) return;
          const element = document.querySelector<HTMLElement>(MAIN_SELECTOR);
          if (element) element.scrollTop = saved;
        });
      }
      return changed;
    },
    getScrollRestorationKey: (location: ParsedLocation) => {
      const entry = entryKey(location);
      main.setCurrent(entry);
      return entry;
    },
    // The workspace <main> is the scroller, not window. Elements without
    // scrollTo (older engines, jsdom) are skipped rather than throwing.
    scrollToTopSelectors: [() => {
      const element = document.querySelector<HTMLElement>(`[data-scroll-restoration-id="${CONTENT_SCROLL_ID}"]`);
      return element && typeof element.scrollTo === "function" ? element : null;
    }],
  };
}
