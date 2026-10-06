import { RouterProvider } from "@tanstack/react-router";
import { router } from "./routes.js";

// The experimental-UI notice now renders inside AppShell, below the top bar,
// so it never covers header controls. Re-exported for existing importers.
export { UI_MAINTENANCE_NOTICE_STORAGE_KEY, UiMaintenanceNotice } from "./components/shell/ExperimentalNotice.js";

export function App() {
  return <RouterProvider router={router} />;
}
