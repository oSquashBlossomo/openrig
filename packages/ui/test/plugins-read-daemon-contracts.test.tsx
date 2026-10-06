import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { PluginDiscoveryService } from "../../daemon/src/domain/plugin-discovery-service.js";
import { pluginsRoutes } from "../../daemon/src/routes/plugins.js";
import { usePlugin, usePlugins, usePluginUsedBy } from "../src/hooks/usePlugins.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanup(); cleanups.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals(); });
function fixture() {
  const root = mkdtempSync("/private/tmp/openrig-plugin-reader-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const roots = ["vendored", "claude-cache", "codex-cache", "agents"].map(p => join(root, p));
  roots.forEach(p => mkdirSync(p));
  const id = "plugin%2F:雪 01", pluginPath = join(roots[0]!, id), manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: "Displayed plugin", version: "01", description: "" }));
  const agentPath = join(roots[3]!, "agent.yaml");
  writeFileSync(agentPath, `name: private-reader-agent\nresources:\n  plugins:\n    - id: ${JSON.stringify(id)}\nprofiles:\n  default:\n    uses:\n      plugins:\n        - ${JSON.stringify(id)}\n`);
  const service = new PluginDiscoveryService({ openrigPluginsDir: roots[0]!, claudeCacheDir: roots[1]!, codexCacheDir: roots[2]!, specLibraryDir: roots[3]!, additionalSpecLibraryDirs: [], cwdScanRoots: [] });
  const app = new Hono(); app.use("*", async (c, next) => { c.set("pluginDiscoveryService" as never, service as never); await next(); }); app.route("/api/plugins", pluginsRoutes());
  return { app, service, id, pluginPath, manifestPath, agentPath };
}
function harness(app: Hono) {
  // Hono's Node Request cannot accept jsdom's AbortSignal. The real signal
  // lifecycle is independently exercised by plugins-read-boundaries.
  const fetch = vi.fn((url: string, init?: RequestInit) => app.request(`http://fixture${url}`, { method: init?.method ?? "GET" }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); cleanups.push(() => client.clear());
  return { fetch, client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
it("production private discovery list/detail/used-by retain exact IDs, nullable/empty/zero and fresh disk facts", async () => {
  const f = fixture(), { fetch, client, wrapper } = harness(f.app);
  const { result } = renderHook(() => ({ list: { ...usePlugins() }, detail: { ...usePlugin(f.id) }, refs: { ...usePluginUsedBy(f.id) } }), { wrapper });
  await waitFor(() => expect(result.current.detail.isSuccess && result.current.list.isSuccess && result.current.refs.isSuccess).toBe(true));
  expect(result.current.list.data).toEqual(f.service.listPlugins()); expect(result.current.detail.data).toEqual(f.service.getPlugin(f.id));
  expect(result.current.detail.data?.entry).toMatchObject({ id: f.id, path: f.pluginPath, version: "01", description: "", skillCount: 0 });
  expect(result.current.detail.data?.codexManifest).toBeNull(); expect(result.current.detail.data?.skills).toEqual([]);
  expect(result.current.refs.data).toEqual([{ agentName: "private-reader-agent", sourcePath: f.agentPath, profiles: ["default"], kind: "consumer" }]);
  expect(fetch.mock.calls.map(([url]) => url)).toContain(`/api/plugins/${encodeURIComponent(f.id)}`);
  expect(client.getQueryData(["plugins", "detail", f.id])).toEqual(result.current.detail.data);
  writeFileSync(f.manifestPath, JSON.stringify({ name: "Displayed plugin", version: "02", description: null, future: false }));
  await act(async () => { await result.current.detail.refetch(); });
  await waitFor(() => expect(result.current.detail.data?.entry.version).toBe("02"));
  expect(result.current.detail.data?.claudeManifest?.raw.future).toBe(false);
});
it("production missing targets and unavailable discovery retain truthful 404/503 errors", async () => {
  const f = fixture(), { wrapper } = harness(f.app);
  const { result, unmount } = renderHook(() => ({ detail: { ...usePlugin("missing%2F") }, refs: { ...usePluginUsedBy("missing%2F") } }), { wrapper });
  await waitFor(() => expect(result.current.detail.error?.message).toBe("HTTP 404"));
  await waitFor(() => expect(result.current.refs.error?.message).toBe("HTTP 404"));
  expect(result.current.detail.data).toBeUndefined(); expect(result.current.refs.data).toBeUndefined(); unmount();
  const unavailable = new Hono(); unavailable.route("/api/plugins", pluginsRoutes()); const h = harness(unavailable);
  const read = renderHook(() => ({ ...usePlugins() }), { wrapper: h.wrapper });
  await waitFor(() => expect(read.result.current.error?.message).toBe("HTTP 503")); expect(read.result.current.data).toBeUndefined();
});
