import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNodePreview, useSessionPreview } from "../src/hooks/useNodePreview.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { configRoutes } from "../../daemon/src/routes/config.js";

let root: string;
const clients: QueryClient[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "preview-settings-contract-"));
  vi.stubEnv("OPENRIG_UI_PREVIEW_DEFAULT_LINES", ""); vi.stubEnv("OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS", "");
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
async function fixture(defaultLines: unknown, refreshIntervalSeconds: unknown) {
  const path = join(root, "config.json"); writeFileSync(path, JSON.stringify({ ui: { preview: { defaultLines, refreshIntervalSeconds } } }));
  const store = new SettingsStore(path); const app = new Hono();
  app.use("*", async (c, next) => { c.set("settingsStore" as never, store); await next(); }); app.route("/api/config", configRoutes({ home: root }));
  const response = await app.request("/api/config"); expect(response.status).toBe(200); const settings = await response.json();
  const previews: string[] = [];
  // Actual settings DTO, fictional preview bytes: no tmux/native capture.
  vi.stubGlobal("fetch", async (url: string) => url === "/api/config" ? { ok: true, json: async () => settings }
    : { ok: true, json: async () => { previews.push(url); return { content: "fixture", lines: 1, sessionName: "fictional@private", capturedAt: "now" }; } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, settings, previews, wrapper };
}
function hook(kind: "node" | "session", opts: { lines?: number; paused?: boolean } = {}) {
  return kind === "node" ? useNodePreview({ rigId: "private", logicalId: "driver", ...opts })
    : useSessionPreview({ sessionName: "fictional@private", ...opts });
}
it.each(["node", "session"] as const)("%s rejects real false interval as polling configuration", async kind => {
  const { settings, previews, wrapper } = await fixture(50, false);
  expect(settings.settings["ui.preview.refresh_interval_seconds"]).toEqual({ value: false, source: "file", defaultValue: 3 });
  vi.useFakeTimers(); renderHook(() => hook(kind), { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(previews).toHaveLength(1); await act(async () => { await vi.advanceTimersByTimeAsync(9000); }); expect(previews.length).toBeGreaterThan(1);
});
it.each(["node", "session"] as const)("%s wrong scalar default lines use50 and invalid interval uses3", async kind => {
  const { settings, previews, client, wrapper } = await fixture(false, "not a number"); expect(settings.settings["ui.preview.default_lines"].value).toBe(false);
  vi.useFakeTimers(); renderHook(() => hook(kind), { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(previews.every(url => url.endsWith("?lines=50"))).toBe(true);
  const key = kind === "node" ? ["node-preview", "private", "driver", 50] : ["session-preview", "fictional@private", 50]; expect(client.getQueryData(key)).toMatchObject({ content: "fixture" });
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); }); expect(previews.length).toBeGreaterThan(1);
});
it.each(["node", "session"] as const)("%s preserves currently accepted finite numeric settings and explicit overrides", async kind => {
  const { previews, wrapper } = await fixture(2.5, 0.25); vi.useFakeTimers(); const { rerender } = renderHook(({ lines }: { lines?: number }) => hook(kind, { lines }), { wrapper, initialProps: { lines: undefined } });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); }); expect(previews.some(url => url.endsWith("?lines=2.5"))).toBe(true);
  const before = previews.length; await act(async () => { await vi.advanceTimersByTimeAsync(260); }); expect(previews.length).toBeGreaterThan(before);
  rerender({ lines: 17 }); await act(async () => { await vi.advanceTimersByTimeAsync(20); }); expect(previews.at(-1)).toMatch(/\?lines=17$/);
});
it.each(["node", "session"] as const)("%s malformed object settings fall back without blocking preview reads", async kind => {
  const { previews, wrapper } = await fixture({ not: "a number" }, {}); vi.useFakeTimers(); renderHook(() => hook(kind), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); }); expect(previews).toHaveLength(1); expect(previews[0]).toMatch(/\?lines=50$/);
});
it.each(["node", "session"] as const)("%s paused cache and manual refetch retain fallback key without polling", async kind => {
  const { client, previews, wrapper } = await fixture("bad", false); const key = kind === "node" ? ["node-preview", "private", "driver", 50] : ["session-preview", "fictional@private", 50];
  const cached = { content: "last capture", lines: 1, sessionName: "fictional@private", capturedAt: "before" }; client.setQueryData(key, cached);
  vi.useFakeTimers(); const { result } = renderHook(() => hook(kind, { paused: true }), { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(previews).toHaveLength(0); expect(result.current.data).toEqual(cached);
  await act(async () => { await result.current.refetch(); await vi.advanceTimersByTimeAsync(10); }); expect(previews).toHaveLength(1); expect(previews[0]).toMatch(/\?lines=50$/);
});
it.each(["node", "session"] as const)("%s retains finite zero settings without inventing positivity policy", async kind => {
  const { settings, previews, wrapper } = await fixture(0, 0); expect(settings.settings["ui.preview.default_lines"].value).toBe(0);
  vi.useFakeTimers(); renderHook(() => hook(kind), { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(previews.at(-1)).toMatch(/\?lines=0$/); const before = previews.length; await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(previews).toHaveLength(before); // Existing numeric-zero interval semantics remain unchanged.
});
