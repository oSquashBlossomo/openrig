// Route binding for the Saved/Derived terminal catalog (terminal-catalog
// cohort). Catalog state lives in TerminalCatalogStateProvider above the
// route Outlet; only the exact selected token rides the URL, so Back from a
// view detail returns to the catalog with filter, scroll and focus intact.

import { useNavigate, useSearch } from "@tanstack/react-router";
import { TerminalCatalog } from "../terminal-catalog/TerminalCatalog.js";
import { validateTerminalsSearch } from "./shell-search.js";

export function TerminalsRoute() {
  const { view } = validateTerminalsSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  return (
    <TerminalCatalog
      view={view ?? null}
      onNavigate={(next) => void navigate({ to: "/terminals", search: next === null ? {} : { view: next } })}
    />
  );
}
