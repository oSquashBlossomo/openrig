// Skill and plugin detail pages: each read (catalog/detail, used-by,
// directory, file) is cold pending, current, cold failure, or retained data
// behind a newer failed refresh with its own receipt time. Only a current
// successful catalog (skill) or the detail endpoint's 404 (plugin) establishes
// absence; used-by is zero only from a successful empty response. Fictional
// fixtures over the real hooks/readers; connected-daemon GETs only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginDetailPage } from "../src/components/specs/PluginDetailPage.js";
import { SkillDetailPage } from "../src/components/specs/SkillDetailPage.js";
import { librarySkillToken } from "../src/lib/library-skills-routing.js";
import type { PluginAgentReference, PluginDetail } from "../src/hooks/usePlugins.js";
import type { LibrarySkillEntry } from "../src/hooks/useLibrarySkills.js";

const PLUGIN = "fixture:plugin%2F", SKILL = "workspace:fixture:skill%2F";
const P = encodeURIComponent(PLUGIN), S = encodeURIComponent(SKILL);
const MTIME = "2026-03-02T10:00:00.000Z";
const detail: PluginDetail = {
  entry: { id: PLUGIN, name: "fixture-plugin", version: "01", description: null, source: "vendored", sourceLabel: "vendored:fixture",
    runtimes: [], path: "/fixture/plugin", lastSeenAt: null, skillCount: 0 },
  claudeManifest: null, codexManifest: null, skills: [], hooks: [], mcpServers: [],
};
const skill: LibrarySkillEntry = { id: SKILL, name: "fixture-skill", source: "workspace", absolutePath: "/fixture/skill", files: [] };
const consumer: PluginAgentReference = { agentName: "fixture-agent", sourcePath: "/fixture/agent.yaml", profiles: [] };

type Reply = number | "hang";
const replies = { catalog: 200 as Reply, catalogBody: [skill] as LibrarySkillEntry[], detail: 200 as Reply, usedBy: 200 as Reply,
  usedByBody: [] as PluginAgentReference[], list: 200 as Reply, read: 200 as Reply };
const requests: Array<{ method: string; url: string }> = [];
let client: QueryClient;

function reply(status: Reply, body: unknown) {
  if (status === "hang") return new Promise<Response>(() => {});
  return Response.json(status === 200 ? body : { error: "fixture_unavailable" }, { status });
}
const fileRead = (path: string) => ({ path, absolutePath: `/fixture/${path}`, content: "# Fixture\n", mtime: MTIME, contentHash: "fixture-hash", size: 10 });

beforeEach(() => {
  Object.assign(replies, { catalog: 200, catalogBody: [skill], detail: 200, usedBy: 200, usedByBody: [], list: 200, read: 200 });
  requests.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ method: init?.method ?? "GET", url });
    if (url === "/api/skills/library") return reply(replies.catalog, replies.catalogBody);
    if (url === `/api/plugins/${P}`) return reply(replies.detail, detail);
    if (url === `/api/plugins/${P}/used-by`) return reply(replies.usedBy, replies.usedByBody);
    const list = /^\/api\/(skills|plugins)\/([^/]+)\/files\/list\?path=(.*)$/.exec(url);
    if (list) return reply(replies.list, { [list[1] === "skills" ? "skillId" : "pluginId"]: decodeURIComponent(list[2]!), path: "",
      entries: [{ name: list[1] === "skills" ? "SKILL.md" : "README.md", type: "file", size: 10, mtime: MTIME }] });
    const read = /^\/api\/(skills|plugins)\/([^/]+)\/files\/read\?path=(.*)$/.exec(url);
    if (read) return reply(replies.read, { [read[1] === "skills" ? "skillId" : "pluginId"]: decodeURIComponent(read[2]!), ...fileRead(decodeURIComponent(read[3]!)) });
    throw new Error(`Unexpected fixture GET ${url}`);
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

const mountSkill = () => render(<QueryClientProvider client={client}><SkillDetailPage skillToken={librarySkillToken(SKILL)} /></QueryClientProvider>);
const mountPlugin = () => render(<QueryClientProvider client={client}><PluginDetailPage pluginId={PLUGIN} /></QueryClientProvider>);
const refetch = (key: unknown[]) => act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
/** The receipt <time> inside a notice must be the query's original receipt. */
const receiptOf = (element: HTMLElement) => element.querySelector("time")?.getAttribute("dateTime");

describe("SkillDetailPage read states", () => {
  it("a cold catalog failure is unavailable, and Retry re-reads the same catalog", async () => {
    replies.catalog = 503;
    mountSkill();
    const unavailable = await screen.findByTestId("skill-detail-unavailable");
    expect(unavailable.textContent).toMatch(/HTTP 503.*unknown/);
    expect(screen.queryByTestId("skill-detail-not-found")).toBeNull();
    replies.catalog = 200;
    fireEvent.click(screen.getByTestId("skill-detail-unavailable-retry"));
    expect(await screen.findByRole("heading", { name: "fixture-skill" })).toBeTruthy();
    expect(requests.filter((r) => r.url === "/api/skills/library")).toHaveLength(2);
  });

  it("a current successful catalog without the skill establishes not found (control)", async () => {
    replies.catalogBody = [];
    mountSkill();
    expect(await screen.findByTestId("skill-detail-not-found")).toBeTruthy();
  });

  it("a failed refresh keeps the skill with its original receipt date; Retry restores current", async () => {
    mountSkill();
    await screen.findByRole("heading", { name: "fixture-skill" });
    const original = client.getQueryState(["skills", "library"])!.dataUpdatedAt;
    replies.catalog = 503;
    await refetch(["skills", "library"]);
    const stale = await screen.findByTestId("skill-detail-catalog-stale");
    expect(stale.textContent).toMatch(/Refreshing the skill library failed \(HTTP 503\)/);
    expect(receiptOf(stale)).toBe(new Date(original).toISOString());
    expect(screen.getByRole("heading", { name: "fixture-skill" })).toBeTruthy();
    replies.catalog = 200;
    fireEvent.click(within(stale).getByTestId("skill-detail-catalog-stale-retry"));
    await waitFor(() => expect(screen.queryByTestId("skill-detail-catalog-stale")).toBeNull());
  });

  it("a retained list without the skill plus a failed refresh is not confirmed, never not found", async () => {
    replies.catalogBody = [];
    mountSkill();
    await screen.findByTestId("skill-detail-not-found");
    replies.catalog = 503;
    await refetch(["skills", "library"]);
    expect(await screen.findByTestId("skill-detail-unconfirmed")).toBeTruthy();
    expect(screen.queryByTestId("skill-detail-not-found")).toBeNull();
  });

  it("a failed directory read is unknown, not empty; file mtime and read receipt are separate", async () => {
    mountSkill();
    const content = await screen.findByTestId("skill-detail-viewer-content");
    expect(within(content).getByTestId("skill-detail-viewer-mtime").querySelector("time")!.getAttribute("dateTime")).toBe(MTIME);
    const readAt = client.getQueryState(["skill-files", "read", SKILL, "SKILL.md"])!.dataUpdatedAt;
    expect(receiptOf(within(content).getByTestId("skill-detail-viewer-read"))).toBe(new Date(readAt).toISOString());
    cleanup(); client.clear();
    replies.list = 503;
    mountSkill();
    expect((await screen.findByTestId("skill-detail-tree-error")).textContent).toMatch(/Directory unavailable: HTTP 503/);
    expect(screen.queryByTestId("skill-detail-tree-empty")).toBeNull();
  });
});

describe("PluginDetailPage read states", () => {
  it("a cold detail failure is unavailable with Retry; HTTP 404 stays the not-found control", async () => {
    replies.detail = 503;
    mountPlugin();
    expect((await screen.findByTestId("plugin-detail-unavailable")).textContent).toMatch(/HTTP 503.*unknown/);
    expect(screen.queryByTestId("plugin-detail-not-found")).toBeNull();
    replies.detail = 200;
    fireEvent.click(screen.getByTestId("plugin-detail-unavailable-retry"));
    expect(await screen.findByTestId("plugin-detail-page")).toBeTruthy();
    cleanup(); client.clear();
    replies.detail = 404;
    mountPlugin();
    expect(await screen.findByTestId("plugin-detail-not-found")).toBeTruthy();
    expect(screen.queryByTestId("plugin-detail-unavailable")).toBeNull();
  });

  it("failed detail refreshes keep dated details: 503 is a failed refresh, 404 says now reported missing", async () => {
    mountPlugin();
    await screen.findByTestId("plugin-detail-page");
    const original = client.getQueryState(["plugins", "detail", PLUGIN])!.dataUpdatedAt;
    replies.detail = 503;
    await refetch(["plugins", "detail", PLUGIN]);
    const stale = await screen.findByTestId("plugin-detail-stale");
    expect(stale.textContent).toMatch(/Refreshing the plugin details failed \(HTTP 503\)/);
    expect(receiptOf(stale)).toBe(new Date(original).toISOString());
    replies.detail = 404;
    await refetch(["plugins", "detail", PLUGIN]);
    await waitFor(() => expect(screen.getByTestId("plugin-detail-stale").textContent).toMatch(/latest read reports this plugin as not found/));
    expect(screen.getByRole("heading", { name: "fixture-plugin" })).toBeTruthy();
  });

  it("used-by: pending and failed are unknown, never zero", async () => {
    replies.usedBy = "hang";
    mountPlugin();
    await screen.findByTestId("plugin-detail-page");
    expect(screen.getByTestId("plugin-detail-used-by-count").getAttribute("data-state")).toBe("pending");
    cleanup(); client.clear();
    replies.usedBy = 503;
    mountPlugin();
    await waitFor(() => expect(screen.getByTestId("plugin-detail-used-by-count").getAttribute("data-state")).toBe("unavailable"));
    expect(screen.getByTestId("plugin-detail-used-by-count").textContent).not.toMatch(/used by 0/);
  });

  it("used-by: a retained count stays dated behind a failed refresh; Retry restores current", async () => {
    replies.usedByBody = [consumer];
    mountPlugin();
    await waitFor(() => expect(screen.getByTestId("plugin-detail-used-by-count").textContent).toMatch(/used by 1 agent$/));
    const original = client.getQueryState(["plugins", "used-by", PLUGIN])!.dataUpdatedAt;
    replies.usedBy = 503;
    await refetch(["plugins", "used-by", PLUGIN]);
    const count = screen.getByTestId("plugin-detail-used-by-count");
    await waitFor(() => expect(count.getAttribute("data-state")).toBe("stale"));
    expect(count.textContent).toMatch(/used by 1 agent as of .*\(refresh failed\)/);
    expect(receiptOf(count)).toBe(new Date(original).toISOString());
    replies.usedBy = 200;
    fireEvent.click(screen.getByTestId("plugin-detail-used-by-retry"));
    await waitFor(() => expect(screen.getByTestId("plugin-detail-used-by-count").getAttribute("data-state")).toBe("current"));
  });

  it("a successful empty used-by establishes zero via exact once-encoded connected-daemon GETs (control)", async () => {
    mountPlugin();
    await waitFor(() => expect(screen.getByTestId("plugin-detail-used-by-count").textContent).toBe("used by 0 agents"));
    expect(requests.map((r) => r.url)).toEqual(expect.arrayContaining([`/api/plugins/${P}`, `/api/plugins/${P}/used-by`]));
    expect(requests.every((r) => r.method === "GET" && !r.url.includes("host="))).toBe(true);
    expect(requests.some((r) => r.url.includes(encodeURIComponent(P)))).toBe(false);
  });

  it("a failed file read is unavailable with Retry", async () => {
    replies.read = 503;
    mountPlugin();
    expect((await screen.findByTestId("plugin-detail-viewer-error")).textContent).toMatch(/File unavailable: HTTP 503/);
    replies.read = 200;
    fireEvent.click(screen.getByTestId("plugin-detail-viewer-retry"));
    expect(await screen.findByTestId("plugin-detail-viewer-content")).toBeTruthy();
  });
});
