import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";

export interface TerminalPreviewPane {
  seat: string;
  label: string;
  readOnly: boolean;
  paneCommand: string;
}

export interface TerminalPreviewDto {
  provider: string;
  view: string;
  planId: string;
  status: { available: boolean };
  composed: {
    id: string;
    opened: TerminalPreviewPane[];
    pages: TerminalPreviewPane[][];
    absent: { seat: string; host: string | null; reason: string }[];
    degraded: { seat: string; host: string; reason: string }[];
  };
  grids: { columns: number; rows: number; blanks: number }[];
}

/** Readiness and geometry belong to the daemon composer. Preview never opens panes. */
export function useTerminalPreview(hostId: string, view: string | undefined, provider: string, enabled: boolean) {
  return useQuery<TerminalPreviewDto>({
    queryKey: ["terminal", "preview", hostId, view, provider],
    enabled: enabled && !!view,
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ view: view!, provider });
      const res = await fetch(withHostParam(`/api/terminal/preview?${params}`, hostId), { signal });
      const body = await res.json();
      if (!res.ok || !body?.planId) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (body.view !== view || body.provider !== provider || typeof body.planId !== "string"
        || typeof body.status?.available !== "boolean" || !Array.isArray(body.composed?.opened)
        || !Array.isArray(body.composed?.absent) || !Array.isArray(body.composed?.degraded)
        || !Array.isArray(body.composed?.pages) || !Array.isArray(body.grids)
        || body.grids.length !== body.composed.pages.length) {
        throw new Error("Terminal preview could not be verified. Refresh before Open.");
      }
      const preview = body as TerminalPreviewDto;
      const panes = preview.composed.pages.flat();
      const validPane = (pane: TerminalPreviewPane) => pane && typeof pane.seat === "string"
        && typeof pane.label === "string" && typeof pane.readOnly === "boolean" && typeof pane.paneCommand === "string";
      const validUnavailable = (seat: { seat: string; reason: string }) => seat
        && typeof seat.seat === "string" && typeof seat.reason === "string";
      if (!preview.composed.pages.every(Array.isArray) || !panes.every(validPane)
        || !preview.composed.opened.every(validPane)
        || !preview.composed.absent.every(validUnavailable) || !preview.composed.degraded.every(validUnavailable)
        || panes.length !== preview.composed.opened.length
        || panes.some((pane, index) => {
          const opened = preview.composed.opened[index]!;
          return pane.seat !== opened.seat || pane.label !== opened.label || pane.readOnly !== opened.readOnly || pane.paneCommand !== opened.paneCommand;
        })
        || !preview.grids.every((grid, index) => grid && Number.isInteger(grid.columns) && grid.columns > 0
          && Number.isInteger(grid.rows) && grid.rows > 0 && Number.isInteger(grid.blanks) && grid.blanks >= 0
          && grid.columns * grid.rows === preview.composed.pages[index]!.length + grid.blanks)) {
        throw new Error("Terminal preview could not be verified. Refresh before Open.");
      }
      return preview;
    },
  });
}
