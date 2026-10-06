// In-memory Files drafts. A draft outlives its editor component so that
// navigating to another file/root/route, or switching hosts, never discards
// or saves it implicitly. Drafts are scoped to the QueryClient (one per app,
// one per test) and are NEVER serialized to URLs, storage or the daemon.
// While any draft differs from its base, a beforeunload prompt asks before a
// reload/close would lose it.

import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { FileLineEnding } from "../../lib/files-text-draft.js";

export interface FileDraftBase {
  /** Raw served content the draft started from (never LF-normalized). */
  raw: string;
  /** LF projection shown in the textarea for that raw base. */
  lfText: string;
  mtime: string;
  contentHash: string;
}

export interface FileDraft {
  key: string;
  originInstance: string | null;
  root: string;
  path: string;
  base: FileDraftBase;
  /** Current textarea value (always LF). */
  draftLf: string;
  /** Deliberate whole-draft ending choice for a mixed base; per base only. */
  mixedChoice?: FileLineEnding;
  /** Last 409 for this base, retained with the draft. */
  conflict?: { currentMtime: string; currentContentHash: string };
  /** A write of `raw` landed; the next read with this hash rebases. */
  saved?: { raw: string; contentHash: string };
}

export function isDraftDirty(draft: FileDraft): boolean {
  return draft.draftLf !== draft.base.lfText;
}

export class FileDraftStore {
  private drafts = new Map<string, FileDraft>();
  private listeners = new Set<() => void>();
  private snapshot: FileDraft[] = [];
  private unloadAttached = false;

  get(key: string): FileDraft | undefined { return this.drafts.get(key); }
  list(): FileDraft[] { return this.snapshot; }

  set(draft: FileDraft): void { this.drafts.set(draft.key, draft); this.emit(); }
  update(key: string, patch: Partial<FileDraft>): void {
    const current = this.drafts.get(key);
    if (current) this.set({ ...current, ...patch });
  }
  delete(key: string): void { if (this.drafts.delete(key)) this.emit(); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    this.snapshot = [...this.drafts.values()];
    this.syncUnloadGuard();
    for (const listener of this.listeners) listener();
  }

  private onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = "";
  };

  private syncUnloadGuard(): void {
    if (typeof window === "undefined") return;
    const dirty = this.snapshot.some(isDraftDirty);
    if (dirty && !this.unloadAttached) { window.addEventListener("beforeunload", this.onBeforeUnload); this.unloadAttached = true; }
    if (!dirty && this.unloadAttached) { window.removeEventListener("beforeunload", this.onBeforeUnload); this.unloadAttached = false; }
  }
}

const stores = new WeakMap<QueryClient, FileDraftStore>();

export function fileDraftStoreFor(client: QueryClient): FileDraftStore {
  let store = stores.get(client);
  if (!store) { store = new FileDraftStore(); stores.set(client, store); }
  return store;
}

export function useFileDraftStore(): FileDraftStore {
  return fileDraftStoreFor(useQueryClient());
}

export function useFileDraft(store: FileDraftStore, key: string): FileDraft | undefined {
  return useSyncExternalStore(store.subscribe, () => store.get(key), () => store.get(key));
}

export function useFileDrafts(store: FileDraftStore): FileDraft[] {
  return useSyncExternalStore(store.subscribe, () => store.list(), () => store.list());
}
