// Shared inert harness for startup / fleet restore / terminal catalog component
// tests. A routed fetch stub stands in for the connected daemon; nothing reaches
// a real daemon, provider or native runtime. The Shell keeps the app-lifetime
// providers mounted while the routed page is swapped, which is exactly how the
// AppShell placement behaves across navigation.

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { ReactNode } from "react";
import { RecoveryOperationsProvider } from "../src/components/startup/RecoveryOperationsProvider.js";
import { TerminalCatalogStateProvider } from "../src/components/terminal-catalog/TerminalCatalogState.js";
import type { FleetRestorePollOptions } from "../src/hooks/useFleetRestore.js";

export interface FetchCall { method: string; path: string; search: URLSearchParams; body: unknown; headers: Headers }
export type Route = (call: FetchCall) => Response | Promise<Response> | undefined;

export function installFetch(route: Route) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://twin.invalid");
    let body: unknown;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    const call: FetchCall = { method: (init.method ?? "GET").toUpperCase(), path: url.pathname, search: url.searchParams, body, headers: new Headers(init.headers) };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const answer = route(call);
    const response = answer instanceof Promise ? await abortable(answer, init.signal) : answer;
    return response ?? Response.json({ error: `unrouted ${call.method} ${call.path}` }, { status: 599 });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch, calls,
    gets: (path: string) => calls.filter(c => c.method === "GET" && c.path === path),
    posts: (path?: string) => calls.filter(c => c.method === "POST" && (path === undefined || c.path === path)),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    promise.then(resolve, reject);
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const json = (value: unknown, status = 200) => Response.json(value, { status });

export function renderShell(page: ReactNode, options: { pollOptions?: FleetRestorePollOptions } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const shell = (content: ReactNode) => (
    <QueryClientProvider client={client}>
      <RecoveryOperationsProvider pollOptions={options.pollOptions}>
        <TerminalCatalogStateProvider>{content}</TerminalCatalogStateProvider>
      </RecoveryOperationsProvider>
    </QueryClientProvider>
  );
  const view = render(shell(page));
  return { ...view, client, show: (next: ReactNode) => view.rerender(shell(next)) };
}
