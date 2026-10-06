// First-load notice about the web UI's status.
//
// Rendered by AppShell in normal document flow directly BELOW the top bar:
// the header (Help, host, theme) always stays at the top and clickable,
// wrapped notice text pushes the workspace down instead of covering it, and
// dismissal removes the element without leaving a reserved gap. (It was a
// fixed top-0 overlay above the z-30 header, which hid Help on first load.)

import { useState } from "react";

// v2: the earlier notice claimed the UI was not under active development,
// which is no longer true. A new key shows the corrected notice once even to
// browsers that dismissed the old one.
export const UI_MAINTENANCE_NOTICE_STORAGE_KEY = "openrig.uiExperimentalNoticeDismissed.v2";

const UI_MAINTENANCE_NOTICE =
  "The OpenRig web UI is experimental and under active development. The CLI and terminal UI remain the reference interfaces; Help (?) lists each command's equivalent here or on the CLI.";

function wasMaintenanceNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function UiMaintenanceNotice() {
  const [dismissed, setDismissed] = useState(wasMaintenanceNoticeDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY, "1");
    } catch {
      // localStorage can be unavailable; dismissal still works for this load.
    }
    setDismissed(true);
  };

  return (
    <div
      className="relative z-20 flex shrink-0 items-start justify-between gap-3 border-b border-amber-500/40 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
      data-testid="ui-maintenance-notice"
      role="status"
    >
      <span className="min-w-0 break-words">{UI_MAINTENANCE_NOTICE}</span>
      <button
        aria-label="Dismiss experimental UI notice"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded font-semibold hover:bg-amber-200/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-900 dark:hover:bg-amber-900"
        onClick={dismiss}
        type="button"
      >
        ×
      </button>
    </div>
  );
}
