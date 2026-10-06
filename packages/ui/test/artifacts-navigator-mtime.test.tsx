// Artifacts navigator compact mtime adopts the connected instance's configured
// `ui.timezone` (shared DisplayTimeProvider), keeps the exact served instant in
// `dateTime`/`title`, follows the existing invalid-zone fallback, and keeps a
// missing or malformed mtime unknown (never now, epoch or an invented date).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DisplayTimeProvider, DisplayZoneNote } from "../src/components/time/DisplayTime.js";
import { ArtifactsNavigator } from "../src/components/project/ArtifactsNavigator.js";

// 22:01Z on 06-23 is 07:01 on 06-24 in Asia/Tokyo and 15:01 on 06-23 in the
// America/Los_Angeles fallback: the configured day/hour is distinguishable.
const SERVED = "2026-06-23T22:01:00.000Z";
const ENTRIES = [
  { name: "README.md", type: "file", size: 4096, mtime: SERVED },
  { name: "NOTES.md", type: "file", size: 10, mtime: null },
  { name: "BAD.md", type: "file", size: 10, mtime: "2026-13-45T99:00:00Z" },
];
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.unstubAllGlobals(); });

function mount(timezone: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test.local");
    if (url.pathname === "/api/config") {
      return Response.json({ settings: timezone === undefined ? {} : { "ui.timezone": { value: timezone, source: "file", defaultValue: "America/Los_Angeles" } } });
    }
    if (url.pathname === "/api/files/roots") return Response.json({ roots: [{ name: "work", path: "/ws" }] });
    if (url.pathname === "/api/files/list") return Response.json({ root: "work", path: url.searchParams.get("path") ?? "", entries: ENTRIES });
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(["hosts"], { ownName: "fixture", selected: "local", hosts: [] });
  render(
    <QueryClientProvider client={client}>
      <DisplayTimeProvider>
        <DisplayZoneNote testId="zone" />
        <ArtifactsNavigator scopePath="/ws/missions/m" scopeLabel="m" />
      </DisplayTimeProvider>
    </QueryClientProvider>,
  );
}
const cell = (name: string) => screen.getByTestId(`artifacts-file-mtime-${name}`);

describe("Artifacts navigator mtime display zone", () => {
  it("shows the configured zone's day and hour and keeps the exact served instant", async () => {
    mount("Asia/Tokyo");
    await waitFor(() => expect(screen.getByTestId("zone").getAttribute("data-state")).toBe("configured"));
    await waitFor(() => expect(cell("README.md").textContent).toBe("06-24 07:01 GMT+9"));
    const time = cell("README.md").querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(SERVED);
    expect(time.getAttribute("title")).toContain(SERVED);
    expect(time.getAttribute("title")).toContain("Asia/Tokyo");
  });

  it("keeps missing and malformed mtimes unknown", async () => {
    mount("Asia/Tokyo");
    await waitFor(() => expect(cell("README.md").textContent).toBe("06-24 07:01 GMT+9"));
    for (const name of ["NOTES.md", "BAD.md"]) {
      expect(cell(name).textContent).toBe("—");
      expect(cell(name).querySelector("time")).toBeNull();
      expect(cell(name).querySelector("[title]")!.getAttribute("title")).toMatch(/time unknown/);
    }
    expect(cell("BAD.md").querySelector("[title]")!.getAttribute("title")).toContain("2026-13-45T99:00:00Z");
  });

  it("follows the explicit fallback for an invalid configured zone", async () => {
    mount("Mars/Olympus");
    await waitFor(() => expect(screen.getByTestId("zone").getAttribute("data-state")).toBe("invalid"));
    await waitFor(() => expect(cell("README.md").textContent).toBe("06-23 15:01 PDT"));
    expect(cell("README.md").querySelector("time")!.getAttribute("title")).toContain("Mars/Olympus");
  });
});
