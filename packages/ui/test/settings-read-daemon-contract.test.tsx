import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSettings } from "../src/hooks/useSettings.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { configRoutes } from "../../daemon/src/routes/config.js";
let root: string;
const clients: QueryClient[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "settings-ui-contract-")); vi.stubEnv("OPENRIG_UI_PREVIEW_DEFAULT_LINES", ""); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture(file: object = {}, available = true) {
  const path = join(root, "config.json"); writeFileSync(path, JSON.stringify(file)); const store = new SettingsStore(path); const app = new Hono();
  app.use("*", async (c, next) => { if (available) c.set("settingsStore" as never, store); await next(); }); app.route("/api/config", configRoutes({ home: root }));
  // Node Request and jsdom AbortSignal use different realms; real query signal
  // cancellation is exercised independently in the read-boundaries suite.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, { method: init?.method, headers: init?.headers }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { app, wrapper };
}
it("accepts actual resolved settings and additive feed host facts", async () => {
  const { app, wrapper } = fixture({ feed: { subscriptions: { "fictional-remote": { enabled: false } } } }); const response = await app.request("/api/config"); expect(response.status).toBe(200);
  const payload = await response.json(); expect(payload.settings["ui.preview.default_lines"]).toEqual({ value: 50, source: "default", defaultValue: 50 });
  expect(payload.feedHostSubscriptions).toEqual([{ hostId: "fictional-remote", enabled: false }]);
  const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.data).toEqual(payload));
});
it("rejects actual malformed file value before preview consumers receive it", async () => {
  const { app, wrapper } = fixture({ ui: { preview: { defaultLines: { wrong: "not a line count" } } } }); const response = await app.request("/api/config"); expect(response.status).toBe(200);
  const payload = await response.json(); expect(payload.settings["ui.preview.default_lines"].value).toEqual({ wrong: "not a line count" });
  const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_contract" })); expect(result.current.data).toBeUndefined();
});
it("preserves real unavailable settings error", async () => {
  const { wrapper } = fixture({}, false); const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.error?.message).toBe("settings_unavailable"));
});
