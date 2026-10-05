// Display-time contract (mirrors packages/tui/src/time.ts) and the shared
// <DisplayTime> element.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_TIME_ZONE, exactInstant, formatDisplayTime, resolveDisplayZone, validTimeZone } from "../src/lib/display-time.js";
import { DisplayTime, DisplayTimeProvider, DisplayZoneNote } from "../src/components/time/DisplayTime.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("formatDisplayTime", () => {
  it("renders one ISO instant in two zones, both with date and zone", () => {
    const iso = "2026-07-01T12:00:00.000Z";
    expect(formatDisplayTime(iso, "Europe/London")).toBe("2026-07-01 13:00:00 GMT+1");
    expect(formatDisplayTime(iso, "America/Los_Angeles")).toBe("2026-07-01 05:00:00 PDT");
  });

  it("follows daylight saving of the named zone, including across a date boundary", () => {
    expect(formatDisplayTime("2026-01-15T07:30:00Z", "America/Los_Angeles")).toBe("2026-01-14 23:30:00 PST");
    // US spring-forward 2026-03-08: 10:00Z is 03:00 PDT; one hour earlier is 01:00 PST.
    expect(formatDisplayTime("2026-03-08T10:00:00Z", "America/Los_Angeles")).toBe("2026-03-08 03:00:00 PDT");
    expect(formatDisplayTime("2026-03-08T09:00:00Z", "America/Los_Angeles")).toBe("2026-03-08 01:00:00 PST");
  });

  it("honours explicit offsets and SQLite UTC stamps", () => {
    expect(formatDisplayTime("2026-07-01T14:00:00+02:00", "Europe/London")).toBe("2026-07-01 13:00:00 GMT+1");
    expect(formatDisplayTime("2026-07-01 12:00:00", "Europe/London")).toBe("2026-07-01 13:00:00 GMT+1");
  });

  it("never reinterprets missing, zone-less or impossible stamps", () => {
    for (const bad of [null, undefined, "", "2026-07-01T12:00:00", "2026-02-30T12:00:00Z", "2026-07-01T25:00:00Z", "yesterday", 1751371200000]) {
      expect(formatDisplayTime(bad, "Europe/London")).toBe("time unknown");
      expect(exactInstant(bad)).toBeNull();
    }
  });

  it("marks an invalid zone as a fallback instead of silently switching", () => {
    expect(validTimeZone("Mars/Base")).toBe(false);
    expect(validTimeZone("+02:00")).toBe(false);
    expect(formatDisplayTime("2026-07-01T12:00:00Z", "Mars/Base")).toBe("2026-07-01 05:00:00 PDT (timezone fallback)");
  });
});

describe("resolveDisplayZone", () => {
  it("distinguishes configured, stale, invalid, unavailable and reading", () => {
    expect(resolveDisplayZone({ setting: { value: "Europe/London", source: "env" }, readState: "ready" }))
      .toMatchObject({ timeZone: "Europe/London", state: "configured", source: "env", note: "Showing Europe/London (ui.timezone · env)." });
    expect(resolveDisplayZone({ setting: { value: "Europe/London", source: "file" }, readState: "stale" }).state).toBe("stale");
    expect(resolveDisplayZone({ setting: { value: "Nowhere/Zone", source: "file" }, readState: "ready" }))
      .toMatchObject({ timeZone: DEFAULT_TIME_ZONE, state: "invalid", configured: "Nowhere/Zone" });
    expect(resolveDisplayZone({ setting: undefined, readState: "ready" }).note).toMatch(/does not report ui.timezone/);
    expect(resolveDisplayZone({ setting: undefined, readState: "failed" }).note).toMatch(/could not be read/);
    expect(resolveDisplayZone({ setting: undefined, readState: "reading" }).state).toBe("reading");
  });
});

describe("<DisplayTime> with the app provider", () => {
  function mount(settingsBody: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(settingsBody, { status })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DisplayTimeProvider>
          <DisplayTime iso="2026-07-01T12:00:00.000Z" testId="t" />
          <DisplayTime iso="not-a-time" testId="bad" />
          <DisplayTime iso={null} testId="none" fallback="not observed" />
          <DisplayZoneNote />
        </DisplayTimeProvider>
      </QueryClientProvider>,
    );
  }

  it("adopts the configured zone and keeps the exact served ISO on the element", async () => {
    mount({ settings: { "ui.timezone": { value: "Europe/London", source: "file", defaultValue: "America/Los_Angeles" } } });
    await waitFor(() => expect(screen.getByTestId("t").textContent).toBe("2026-07-01 13:00:00 GMT+1"));
    expect(screen.getByTestId("t").getAttribute("datetime")).toBe("2026-07-01T12:00:00.000Z");
    expect(screen.getByTestId("t").getAttribute("title")).toMatch(/^2026-07-01T12:00:00.000Z · Showing Europe\/London/);
    expect(screen.getByTestId("bad").textContent).toBe("time unknown");
    expect(screen.getByTestId("none").textContent).toBe("not observed");
    expect(screen.getByTestId("display-zone-note").getAttribute("data-state")).toBe("configured");
  });

  it("states the fallback when settings cannot be read", async () => {
    mount({ error: "unavailable" }, 503);
    await waitFor(() => expect(screen.getByTestId("display-zone-note").getAttribute("data-state")).toBe("unavailable"));
    expect(screen.getByTestId("display-zone-note").textContent).toMatch(/Settings could not be read; showing America\/Los_Angeles \(fallback\)/);
    expect(screen.getByTestId("t").textContent).toBe("2026-07-01 05:00:00 PDT");
  });
});
