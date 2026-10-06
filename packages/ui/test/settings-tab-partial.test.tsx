// SettingsTab against actual served settings maps.
//
// - Older daemon: `fixtures/settings-v030-response.json` is the exact GET
//   body produced by the v0.3.0 SettingsStore (extracted from the v0.3.0 tag,
//   fictional temp config, paths sanitised). It lacks today's
//   workspace.projects_root / workspace.catalog_path / ui.timezone keys and
//   the additive feedHostSubscriptions field.
// - Current daemon: the actual SettingsStore + config route (private temp
//   config file, Hono app; nothing touches a real instance).
//
// The compatible partial-map reader stays unchanged; the component must
// render what is served and nothing more.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { configRoutes } from "../../daemon/src/routes/config.js";
import { SettingsTab, settingText } from "../src/components/system/SettingsTab.js";
import { DisplayTimeProvider } from "../src/components/time/DisplayTime.js";
import v030 from "./fixtures/settings-v030-response.json";

class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) { return { message: error.message }; }
  render() { return this.state.message ? <div data-testid="component-crash">{this.state.message}</div> : this.props.children; }
}

const roots: string[] = [];
let client: QueryClient | undefined;
afterEach(() => {
  cleanup(); client?.clear(); client = undefined; vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

type Call = { method: string; path: string; body: unknown };
function serve(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://local");
    const call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><DisplayTimeProvider><Boundary><SettingsTab /></Boundary></DisplayTimeProvider></QueryClientProvider>);
  return client;
}

describe("SettingsTab · served settings maps", () => {
  it("renders an actual v0.3.0 map: served values exact, missing keys unavailable with no invented default/edit/reset", async () => {
    expect(v030.settings).not.toHaveProperty("workspace.projects_root");
    expect(v030.settings).not.toHaveProperty("ui.timezone");
    serve(() => Response.json(v030));
    mount();
    await screen.findByTestId("settings-tab");
    expect(screen.queryByTestId("component-crash")).toBeNull();

    const root = screen.getByTestId("setting-workspace.root");
    expect(root.getAttribute("data-state")).toBe("served");
    expect(within(root).getByTestId("setting-workspace.root-value").textContent).toBe("/home/demo/.openrig/fictional-workspace");
    expect(root.textContent).toContain("source: file");
    expect(within(root).getByTestId("setting-workspace.root-default").textContent).toBe("default: /home/demo/.openrig/workspace");
    expect(within(root).getByTestId("setting-workspace.root-reset")).toBeTruthy();

    for (const key of ["workspace.projects_root", "workspace.catalog_path", "ui.timezone"]) {
      const row = screen.getByTestId(`setting-${key}`);
      expect(row.getAttribute("data-state")).toBe("unavailable");
      expect(row.textContent).toMatch(/does not serve .*no value or default is assumed/);
      expect(row.textContent).not.toMatch(/default:/);
      expect(within(row).queryByRole("button")).toBeNull();
    }
    expect(screen.getByTestId("setting-transcripts.enabled-value").textContent).toBe("true");
    // Missing ui.timezone: a truthful fallback, not a configured zone.
    expect(screen.getByTestId("settings-display-zone").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByTestId("settings-display-zone").textContent).toMatch(/does not report ui.timezone; showing America\/Los_Angeles \(fallback\)/);
  });

  it("renders the actual current SettingsStore + config route (control)", async () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-settings-current-"));
    roots.push(root);
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ workspace: { root: join(root, "fictional-workspace") }, ui: { timezone: "Europe/London" } }));
    const store = new SettingsStore(file);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("settingsStore" as never, store as never); await next(); });
    app.route("/api/config", configRoutes({ home: root }));
    // jsdom's AbortSignal is not Node's; forward only method/body to the Hono app.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), { method: init?.method, body: init?.body, headers: init?.headers }));
    mount();
    await screen.findByTestId("settings-tab");
    expect(screen.queryByTestId("component-crash")).toBeNull();
    expect(screen.getByTestId("setting-workspace.projects_root").getAttribute("data-state")).toBe("served");
    expect(screen.getByTestId("setting-ui.timezone-value").textContent).toBe("Europe/London");
    expect(within(screen.getByTestId("setting-ui.timezone")).queryByRole("button")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("settings-display-zone").textContent).toMatch(/Showing Europe\/London \(ui.timezone · file\)/));
  });

  it("shows false, zero and empty values exactly", async () => {
    serve(() => Response.json({ settings: {
      "transcripts.enabled": { value: false, source: "file", defaultValue: true },
      "daemon.port": { value: 0, source: "env", defaultValue: 7433 },
      "files.allowlist": { value: "", source: "default", defaultValue: "" },
    } }));
    mount();
    expect((await screen.findByTestId("setting-transcripts.enabled-value")).textContent).toBe("false");
    expect(screen.getByTestId("setting-transcripts.enabled-default").textContent).toBe("default: true");
    expect(screen.getByTestId("setting-daemon.port-value").textContent).toBe("0");
    expect(screen.getByTestId("setting-files.allowlist-value").textContent).toBe("(empty)");
    expect(settingText(false)).toBe("false");
  });

  it("keeps the last read, dated and labeled, after a failed refresh, and recovers on Retry", async () => {
    let failing = false;
    serve(() => (failing ? Response.json({ error: "settings_unavailable" }, { status: 503 }) : Response.json(v030)));
    const qc = mount();
    await screen.findByTestId("setting-workspace.root-value");
    failing = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["settings", "all"] }); });
    const stale = await screen.findByTestId("settings-stale");
    expect(stale.textContent).toMatch(/Settings refresh failed · showing last successful read/);
    expect(stale.textContent).toMatch(/settings_unavailable/);
    expect(screen.getByTestId("setting-workspace.root-value").textContent).toBe("/home/demo/.openrig/fictional-workspace");
    failing = false;
    fireEvent.click(screen.getByTestId("settings-retry"));
    await waitFor(() => expect(screen.queryByTestId("settings-stale")).toBeNull());
  });

  it("a cold failure is reported, not rendered as an empty settings list", async () => {
    serve(() => Response.json({ error: "settings_unavailable" }, { status: 503 }));
    mount();
    expect((await screen.findByTestId("settings-error")).textContent).toMatch(/Settings unavailable/);
    expect(screen.queryByTestId("settings-tab")).toBeNull();
  });

  it("preserves supported writes: edit from the current value, save, reset and Init Workspace", async () => {
    let root = "/home/demo/.openrig/fictional-workspace";
    const calls = serve((call) => {
      if (call.method === "GET" && call.path === "/api/config") {
        return Response.json({ ...v030, settings: { ...v030.settings, "workspace.root": { ...v030.settings["workspace.root"], value: root } } });
      }
      if (call.method === "POST" && call.path === "/api/config/init-workspace") {
        return Response.json({ root, rootCreated: false, subdirs: [{ name: "missions", path: `${root}/missions`, created: true }], files: [], dryRun: false });
      }
      return Response.json({ ok: true, resolved: v030.settings["workspace.root"] });
    });
    const qc = mount();
    await screen.findByTestId("setting-workspace.root-value");
    // The served value changes after mount; Edit must start from it.
    root = "/home/demo/.openrig/moved-workspace";
    await act(async () => { await qc.refetchQueries({ queryKey: ["settings", "all"] }); });
    await waitFor(() => expect(screen.getByTestId("setting-workspace.root-value").textContent).toBe(root));
    fireEvent.click(screen.getByTestId("setting-workspace.root-edit"));
    expect((screen.getByTestId("setting-workspace.root-input") as HTMLInputElement).value).toBe(root);
    fireEvent.change(screen.getByTestId("setting-workspace.root-input"), { target: { value: "/home/demo/next" } });
    fireEvent.click(screen.getByTestId("setting-workspace.root-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/config/workspace.root")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/config/workspace.root")?.body).toEqual({ value: "/home/demo/next" });

    fireEvent.click(await screen.findByTestId("setting-workspace.root-reset"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/config/workspace.root")).toBe(true));
    fireEvent.click(screen.getByTestId("settings-init-workspace"));
    expect((await screen.findByTestId("settings-init-result")).textContent).toMatch(/created 1 subdir/);
    // Unavailable keys never produce a write.
    expect(calls.some((c) => c.path.includes("projects_root") || c.path.includes("catalog_path"))).toBe(false);
  });
});
