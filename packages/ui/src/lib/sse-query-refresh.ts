import { useEffect, useMemo } from "react";
import { useQueryClient, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

type Lease = object;
interface Followup { timer: ReturnType<typeof setTimeout>; leases: Set<Lease> }

/** One refresh owner per QueryClient. Producers retain their existing event
 * membership and debounce windows, but cannot cancel one another's reads.
 * Receipt identity deduplicates ONE delivered event across subscribers; equal
 * type/entity/time fields on distinct delivered events are never deduplicated. */
class SseQueryRefresh {
  private leases = new Set<Lease>();
  private afterRead = new Map<Query, Set<Lease>>();
  private followups = new Map<Query, Followup>();
  private receipts = new Map<Query, WeakSet<object>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private client: QueryClient) {}

  retain(lease: Lease) {
    this.leases.add(lease);
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.getQueryCache().subscribe(event => {
      const query = event.query;
      if (event.type === "removed") {
        this.afterRead.delete(query);
        this.receipts.delete(query);
        const followup = this.followups.get(query);
        if (followup) clearTimeout(followup.timer);
        this.followups.delete(query);
      } else if (event.type === "updated" && query.state.fetchStatus === "idle") {
        const leases = this.afterRead.get(query);
        if (!leases) return;
        this.afterRead.delete(query);
        if (!query.isActive() || !leases.size) return;
        const queued = this.followups.get(query);
        if (queued) { for (const lease of leases) queued.leases.add(lease); return; }
        const timer = setTimeout(() => {
          this.followups.delete(query);
          if (leases.size && query.isActive() && this.client.getQueryCache().get(query.queryHash) === query) this.refetch(query);
        }, 0);
        this.followups.set(query, { timer, leases });
      }
    });
  }

  release(lease: Lease) {
    this.leases.delete(lease);
    for (const [query, leases] of this.afterRead) {
      leases.delete(lease);
      if (!leases.size) this.afterRead.delete(query);
    }
    for (const [query, followup] of this.followups) {
      followup.leases.delete(lease);
      if (!followup.leases.size) { clearTimeout(followup.timer); this.followups.delete(query); }
    }
    if (this.leases.size) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.receipts.clear();
  }

  refresh(lease: Lease, queryKey: QueryKey, delivered: Iterable<object> = []) {
    if (!this.leases.has(lease)) return;
    const events = [...delivered];
    const queries = this.client.getQueryCache().findAll({ queryKey });
    if (!queries.length) {
      // Preserve invalidation intent even when the prefix has no cache entry.
      void this.client.invalidateQueries({ queryKey, refetchType: "none" });
    }
    for (const query of queries) {
      let novel = events.length === 0;
      let seen = this.receipts.get(query);
      if (!seen) { seen = new WeakSet(); this.receipts.set(query, seen); }
      for (const event of events) {
        if (!seen.has(event)) { seen.add(event); novel = true; }
      }
      if (!novel) {
        // A second subscriber also owns already-pending work; releasing the
        // first subscriber must not discard the surviving owner's follow-up.
        this.afterRead.get(query)?.add(lease);
        this.followups.get(query)?.leases.add(lease);
        continue;
      }
      void this.client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
      if (!query.isActive()) continue;
      const queued = this.followups.get(query);
      if (queued && query.state.fetchStatus === "idle") { queued.leases.add(lease); continue; }
      if (query.state.fetchStatus === "idle") this.refetch(query);
      else {
        const leases = this.afterRead.get(query) ?? new Set<Lease>();
        leases.add(lease);
        this.afterRead.set(query, leases);
      }
    }
  }

  private refetch(query: Query) {
    // A focus/poll read started since settlement satisfies queued work too.
    // Refetching never cancels that read or resets its transport deadline.
    void this.client.refetchQueries({ queryKey: query.queryKey, exact: true, type: "active" }, { cancelRefetch: false });
  }
}

const schedulers = new WeakMap<QueryClient, SseQueryRefresh>();

/** Effect-scoped lease: no timers/subscriptions are created during render,
 * and unmount discards only this producer's pending work. Shared query reads
 * and surviving producers remain untouched. */
export function useSseQueryRefresh(identity?: unknown) {
  const client = useQueryClient();
  const owner = useMemo(() => {
    let scheduler = schedulers.get(client);
    if (!scheduler) { scheduler = new SseQueryRefresh(client); schedulers.set(client, scheduler); }
    const lease: Lease = {};
    return { scheduler, lease, refresh: (key: QueryKey, receipts?: Iterable<object>) => scheduler.refresh(lease, key, receipts) };
  }, [client, identity]);
  useEffect(() => { owner.scheduler.retain(owner.lease); return () => owner.scheduler.release(owner.lease); }, [owner]);
  return owner.refresh;
}
