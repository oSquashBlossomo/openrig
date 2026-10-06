import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routes.js", () => ({ router: {} }));

import {
  UI_MAINTENANCE_NOTICE_STORAGE_KEY,
  UiMaintenanceNotice,
} from "../src/App.js";

describe("UI maintenance notice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(cleanup);

  it("shows the experimental, actively developed posture on first load", () => {
    render(<UiMaintenanceNotice />);

    const text = screen.getByTestId("ui-maintenance-notice").textContent ?? "";
    expect(text).toContain("experimental and under active development");
    expect(text).toContain("The CLI and terminal UI remain the reference interfaces");
    // The obsolete abandonment claim is gone.
    expect(text).not.toMatch(/not under active development|maintenance mode/);
  });

  it("is shown again to browsers that dismissed the obsolete notice", () => {
    localStorage.setItem("openrig.uiMaintenanceNoticeDismissed", "1");
    render(<UiMaintenanceNotice />);
    expect(screen.getByTestId("ui-maintenance-notice")).toBeTruthy();
  });

  it("is in normal flow, dismisses without leaving an element and stays dismissed after remount", () => {
    const first = render(<UiMaintenanceNotice />);
    const notice = screen.getByTestId("ui-maintenance-notice");

    // In normal flow (AppShell renders it below the header): never a fixed
    // overlay that could cover header controls such as Help.
    expect(notice.className).not.toMatch(/\b(fixed|absolute)\b/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss experimental UI notice" }));

    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
    expect(localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY)).toBe("1");

    first.unmount();
    render(<UiMaintenanceNotice />);
    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
  });
});
