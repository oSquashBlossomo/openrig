import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalCatalog } from "../src/components/terminal-catalog/TerminalCatalog.js";
import { buildTerminalCatalog, parseTypedViewToken } from "../src/components/terminal-catalog/catalog-model.js";
import { TERMINAL_BEARER_STORAGE_KEY } from "../src/components/mission-control/missionControlAuth.js";
import type { TerminalPreviewDto } from "../src/lib/terminal-read.js";
import {
  recoveryHostsLocal, recoveryHostsRemote, terminalPreviewFixture, terminalViewsEmpty, terminalViewsFixture, terminalViewsSavedOnly,
} from "../twin/recovery-fixtures.js";
import { deferred, installFetch, json, renderShell, type FetchCall } from "./recovery-harness.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const wall = terminalViewsFixture.saved[1]!.members.map(m => m.seat);
type PreviewAnswer = TerminalPreviewDto | Response;

function daemon(options: {
  hosts?: unknown; views?: unknown; preview?: (view: string, provider: string) => PreviewAnswer;
  open?: (call: FetchCall) => Response | Promise<Response>;
} = {}) {
  return installFetch(call => {
    if (call.path === "/api/hosts") return json(options.hosts ?? recoveryHostsLocal);
    if (call.path === "/api/terminal/views") return json(options.views ?? terminalViewsFixture);
    if (call.path === "/api/terminal/preview") {
      const view = call.search.get("view")!; const provider = call.search.get("provider")!;
      const answer = options.preview ? options.preview(view, provider) : terminalPreviewFixture(view, provider, ["orch.lead@alpha"]);
      return answer instanceof Response ? answer : json(answer);
    }
    if (call.method === "POST" && call.path === "/api/terminal/open") return options.open ? options.open(call) : json({ provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 0 });
    return undefined;
  });
}

const previews = (net: ReturnType<typeof daemon>) => net.gets("/api/terminal/preview");

async function openDetail(token: string) {
  fireEvent.click(await screen.findByTestId(`terminal-row-${token}`));
  return screen.findByTestId("terminal-detail");
}

async function openEnabled() {
  const button = await screen.findByTestId("terminal-open") as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("catalog model", () => {
  it("builds exact Saved and Derived tokens and refuses bare names", () => {
    const entries = buildTerminalCatalog(terminalViewsFixture);
    expect(entries.map(e => e.token)).toEqual(["saved:sv-alpha-pair", "saved:sv-wall", "saved:sv-mixed", "rig:alpha", "rig:beta"]);
    expect(entries.find(e => e.token === "saved:sv-alpha-pair")!.sameNameTokens).toEqual(["rig:alpha"]);
    expect(parseTypedViewToken("alpha")).toMatchObject({ ok: false });
    expect(parseTypedViewToken("pod:")).toMatchObject({ ok: false });
    expect(parseTypedViewToken("pod:alpha/core")).toEqual({ ok: true, token: "pod:alpha/core", kind: "pod" });
  });
});

describe("independent terminal catalog", () => {
  it("works with zero rigs: Saved stays reachable and Derived states its own emptiness", async () => {
    daemon({ views: terminalViewsSavedOnly });
    renderShell(<TerminalCatalog />);
    expect(await screen.findByTestId("terminal-row-saved:sv-wall")).toBeTruthy();
    expect(screen.getByTestId("terminal-derived-empty").textContent).toMatch(/No rigs/);
    cleanup(); vi.unstubAllGlobals();
    daemon({ views: terminalViewsEmpty });
    renderShell(<TerminalCatalog />);
    expect(await screen.findByTestId("terminal-saved-empty")).toBeTruthy();
    expect(screen.getByTestId("terminal-derived-empty")).toBeTruthy();
  });

  it("keeps the exact token when a saved view and a rig share a name", async () => {
    const net = daemon();
    renderShell(<TerminalCatalog />);
    const row = await screen.findByTestId("terminal-row-saved:sv-alpha-pair");
    expect(row.textContent).toMatch(/same name as rig:alpha/);
    await openDetail("saved:sv-alpha-pair");
    expect(screen.getByTestId("terminal-detail-token").textContent).toBe("saved:sv-alpha-pair");
    await waitFor(() => expect(previews(net)).toHaveLength(1));
    expect(previews(net)[0]!.search.get("view")).toBe("saved:sv-alpha-pair");
    expect(previews(net)[0]!.search.get("provider")).toBe("herdr");
    expect(net.calls.some(c => c.search.get("view") === "rig:alpha" || c.search.get("view") === "alpha")).toBe(false);
  });

  it("renders the served 16+1 pages for 17 members and pages without reading or opening anything", async () => {
    const net = daemon({ preview: (view, provider) => terminalPreviewFixture(view, provider, wall) });
    renderShell(<TerminalCatalog />);
    await openDetail("saved:sv-wall");
    expect((await screen.findByTestId("terminal-page-label")).textContent).toBe("Page 1 of 2");
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(16);
    expect(screen.getByTestId("terminal-plan-summary").textContent).toMatch(/17 attachable · 0 absent · 0 degraded · 2 pages/);
    const reads = previews(net).length;
    fireEvent.click(screen.getByTestId("terminal-page-next"));
    expect(screen.getByTestId("terminal-page-label").textContent).toBe("Page 2 of 2");
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
    expect((screen.getByTestId("terminal-page-next") as HTMLButtonElement).disabled).toBe(true);
    expect(previews(net)).toHaveLength(reads);
    expect(net.posts()).toHaveLength(0);
    expect((await openEnabled()).textContent).toBe("Open 17 panes in herdr · 2 pages");
  });

  it("opens exactly the validated plan with terminal authorization", async () => {
    localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, "demo-terminal-token");
    const net = daemon({ preview: (view, provider) => terminalPreviewFixture(view, provider, ["orch.lead@alpha"], { planId: "plan/exact 1" }),
      open: () => json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 }) });
    renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    expect(await screen.findByTestId("terminal-open-result")).toBeTruthy();
    expect(net.posts("/api/terminal/open")).toHaveLength(1);
    const call = net.posts("/api/terminal/open")[0]!;
    expect(call.body).toEqual({ provider: "herdr", view: "rig:alpha", expectedPlan: "plan/exact 1" });
    expect(call.headers.get("Authorization")).toBe("Bearer demo-terminal-token");
  });

  it("refreshes the preview on a stale-plan 409 and never repeats Open by itself", async () => {
    let plan = "plan-1";
    const net = daemon({
      preview: (view, provider) => terminalPreviewFixture(view, provider, ["orch.lead@alpha"], { planId: plan }),
      open: () => { plan = "plan-2"; return json({ provider: "herdr", ok: false, code: "preview_changed", error: "plan changed", opened: [], absent: [], degraded: [], pages: 0 }, 409); },
    });
    renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    expect(await screen.findByTestId("terminal-open-plan-changed")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("terminal-plan-id").textContent).toBe("plan-2"));
    expect(previews(net).length).toBeGreaterThanOrEqual(2);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(net.posts("/api/terminal/open")).toHaveLength(1);
  });

  it("reports HTTP 200 with zero opened panes as failure", async () => {
    daemon({ open: () => json({ provider: "herdr", ok: false, code: "provider_unavailable", error: "herdr not reachable", opened: [], absent: [], degraded: [], pages: 0 }) });
    renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    const zero = await screen.findByTestId("terminal-open-zero");
    expect(zero.textContent).toMatch(/Open failed · nothing opened/);
    expect(zero.textContent).toMatch(/provider_unavailable: herdr not reachable/);
  });

  it("names every omission in a partial Open result", async () => {
    const seats = ["orch.lead@alpha", "build.worker@alpha", "w01.agent@alpha"];
    daemon({
      preview: (view, provider) => terminalPreviewFixture(view, provider, seats),
      open: () => json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [{ seat: "build.worker@alpha", host: null, reason: "session ended" }], degraded: [], pages: 1 }),
    });
    renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    const result = await screen.findByTestId("terminal-open-result");
    expect(result.textContent).toMatch(/Opened · partial/);
    expect(within(result).getByTestId("terminal-open-disclosure").textContent).toBe("build.worker@alpha: session ended");
    expect(within(result).getByTestId("terminal-open-omitted").textContent).toMatch(/w01\.agent@alpha/);
  });

  it("keeps a lost Open response uncertain and holds Open until a newer preview is read", async () => {
    const net = daemon({ open: () => { throw new TypeError("connection reset"); } });
    renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    expect(await screen.findByTestId("terminal-open-uncertain")).toBeTruthy();
    expect((screen.getByTestId("terminal-open") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("terminal-open-hold").textContent).toMatch(/outcome is unknown/);
    await new Promise(resolve => setTimeout(resolve, 5));
    fireEvent.click(screen.getByTestId("terminal-preview-refresh"));
    await openEnabled();
    expect(net.posts("/api/terminal/open")).toHaveLength(1);
  });

  it("keeps a pending Open's result across leaving and returning to the detail", async () => {
    const answer = deferred<Response>();
    const net = daemon({ open: () => answer.promise });
    const app = renderShell(<TerminalCatalog />);
    await openDetail("rig:alpha");
    fireEvent.click(await openEnabled());
    expect(await screen.findByTestId("terminal-open-pending")).toBeTruthy();
    app.show(<p>elsewhere</p>);
    await act(async () => { answer.resolve(json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 })); });
    app.show(<TerminalCatalog view="rig:alpha" />);
    expect(await screen.findByTestId("terminal-open-result")).toBeTruthy();
    app.show(<TerminalCatalog view="rig:beta" />);
    await screen.findByTestId("terminal-plan");
    expect(screen.queryByTestId("terminal-open-result")).toBeNull();
    expect(net.posts()).toHaveLength(1);
  });

  it("accepts a full typed pod token, reports an unavailable target without fallback, and refuses bare names", async () => {
    const net = daemon({ preview: view => view === "pod:alpha/core" ? json({ error: "unknown pod 'core' in rig 'alpha'", code: "view_not_found" }, 404) : terminalPreviewFixture(view, "herdr", []) });
    renderShell(<TerminalCatalog />);
    const input = await screen.findByTestId("terminal-typed-input");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.click(screen.getByTestId("terminal-typed-submit"));
    expect(screen.getByTestId("terminal-typed-error").textContent).toMatch(/Bare names are not resolved/);
    expect(previews(net)).toHaveLength(0);

    fireEvent.change(input, { target: { value: "pod:alpha/core" } });
    fireEvent.click(screen.getByTestId("terminal-typed-submit"));
    const error = await screen.findByTestId("terminal-preview-error");
    expect(error.textContent).toMatch(/Target unavailable/);
    expect(error.textContent).toMatch(/no other view is tried/);
    expect(screen.getByTestId("terminal-detail-uncatalogued")).toBeTruthy();
    expect(previews(net).map(c => c.search.get("view"))).toEqual(["pod:alpha/core"]);
    expect((screen.getByTestId("terminal-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps filter, focus and scroll context across detail and Back", async () => {
    daemon();
    const app = renderShell(<TerminalCatalog view={null} />);
    fireEvent.change(await screen.findByTestId("terminal-catalog-filter"), { target: { value: "w07" } });
    expect(screen.getAllByRole("button").filter(b => b.dataset.token).map(b => b.dataset.token)).toEqual(["saved:sv-wall"]);
    const scroller = screen.getByTestId("terminal-catalog-scroll");
    scroller.scrollTop = 120; fireEvent.scroll(scroller);
    fireEvent.click(screen.getByTestId("terminal-row-saved:sv-wall"));
    app.show(<TerminalCatalog view="saved:sv-wall" />);
    expect(await screen.findByTestId("terminal-detail")).toBeTruthy();
    app.show(<TerminalCatalog view={null} />);
    expect((await screen.findByTestId("terminal-catalog-filter") as HTMLInputElement).value).toBe("w07");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-token")).toBe("saved:sv-wall"));
    expect(screen.getByTestId("terminal-catalog-scroll").scrollTop).toBe(120);
  });

  it("disables Open when the provider is down and shows saved member modes and SSH caveats", async () => {
    daemon({ preview: (view, provider) => provider === "cmux"
      ? terminalPreviewFixture(view, provider, ["orch.lead@alpha"], { available: false })
      : terminalPreviewFixture(view, provider, ["orch.lead@alpha", "remote.watch@edge"], { readOnly: s => s.endsWith("@edge"), ssh: s => s.endsWith("@edge") }) });
    renderShell(<TerminalCatalog />);
    await openDetail("saved:sv-mixed");
    await screen.findByTestId("terminal-plan");
    const panes = screen.getAllByTestId("terminal-pane").map(p => p.textContent);
    expect(panes[0]).toMatch(/interactive/);
    expect(panes[1]).toMatch(/read-only · over SSH, login not verified/);
    expect(screen.getByTestId("terminal-saved-membership").textContent).toMatch(/host edge-demo/);
    fireEvent.click(screen.getByTestId("terminal-provider-cmux"));
    expect(await screen.findByTestId("terminal-provider-unavailable")).toBeTruthy();
    expect((screen.getByTestId("terminal-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads nothing under a remote host selection", async () => {
    const net = daemon({ hosts: recoveryHostsRemote });
    renderShell(<TerminalCatalog view="rig:alpha" />);
    expect(await screen.findByTestId("terminal-detail-remote-scope")).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(net.calls.filter(c => c.path.startsWith("/api/terminal"))).toHaveLength(0);
  });
});
