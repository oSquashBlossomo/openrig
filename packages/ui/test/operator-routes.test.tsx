// Route wiring for the connected-instance operator pages in the ACTUAL route
// tree: each path keeps its validated search contract, is lazily loaded with
// truthful pending/error fallbacks, and its chunk resolves to the page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, type AnyRoute } from "@tanstack/react-router";
import { routeTree } from "../src/routes.js";
import {
  validateConfigurationSearch, validateConnectionsSearch, validateForYouSearch, validateHealthSearch,
} from "../src/components/operator/operator-search.js";
import { OperatorRouteError, OperatorRoutePending } from "../src/components/operator/OperatorRouteFallback.js";
import { operatorTwinBody } from "../twin/operator-fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function findRoute(path: string): AnyRoute {
  const children = (routeTree as unknown as { children: AnyRoute[] | Record<string, AnyRoute> }).children;
  const list = Array.isArray(children) ? children : Object.values(children);
  const route = list.find((r) => (r.options as { path?: string }).path === path);
  if (!route) throw new Error(`route ${path} missing`);
  return route;
}

const OPERATOR_ROUTES = [
  { path: "/for-you", validate: validateForYouSearch, testId: "for-you-page" },
  { path: "/settings/health", validate: validateHealthSearch, testId: "operator-health-page" },
  { path: "/settings/configuration", validate: validateConfigurationSearch, testId: "operator-configuration-page" },
  { path: "/settings/connections", validate: validateConnectionsSearch, testId: "operator-connections-page" },
] as const;

describe("operator routes", () => {
  for (const { path, validate, testId } of OPERATOR_ROUTES) {
    it(`${path} validates search, lazy-loads its page and has truthful fallbacks`, async () => {
      const route = findRoute(path);
      expect(route.options.validateSearch).toBe(validate);
      const component = route.options.component as { preload?: () => Promise<void> };
      expect(typeof component.preload).toBe("function");
      await component.preload!();
      expect(route.options.pendingComponent).toBeTypeOf("function");
      expect(route.options.errorComponent).toBeTypeOf("function");

      // Render the actual lazy component under a minimal router + client.
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
        const served = operatorTwinBody(url.pathname, url.searchParams);
        return served ? Response.json(served.body, { status: served.status }) : Response.json({ error: "not_found" }, { status: 404 });
      }));
      vi.stubGlobal("EventSource", vi.fn());
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider> });
      const child = createRoute({ getParentRoute: () => root, path, validateSearch: validate, component: route.options.component } as never);
      const router = createRouter({ routeTree: root.addChildren([child]), history: createMemoryHistory({ initialEntries: [path] }) });
      render(<RouterProvider router={router} />);
      expect(await screen.findByTestId(testId)).toBeTruthy();
      qc.clear();
    });
  }

  // Cohort/shell routes mounted by the shared owner. Rendering through the
  // root providers is covered in shared-shell-integration.test.tsx.
  for (const { path, exportName } of [
    { path: "/settings/startup", exportName: "StartupPage" },
    { path: "/settings/restore", exportName: "FleetRestorePage" },
    { path: "/terminals", exportName: "TerminalsRoute" },
    { path: "/project/catalog", exportName: "CatalogProjectRoute" },
    { path: "/help", exportName: "HelpPage" },
    { path: "/files", exportName: "FilesRoutePage" },
    { path: "/pulse", exportName: "RecentPulseRoute" },
  ]) {
    it(`${path} is lazily loaded (${exportName}) with truthful fallbacks`, async () => {
      const route = findRoute(path);
      const component = route.options.component as { preload?: () => Promise<void> };
      expect(typeof component.preload).toBe("function");
      await component.preload!();
      expect(route.options.pendingComponent).toBeTypeOf("function");
      expect(route.options.errorComponent).toBeTypeOf("function");
      // Exact catalog identities are read raw from publicHref: no coercing validator.
      if (path === "/project/catalog" || path === "/files" || path === "/pulse") expect(route.options.validateSearch).toBeUndefined();
    });
  }

  it("validators drop malformed values and keep exact identifiers verbatim", () => {
    expect(validateHealthSearch({ severity: "fatal", scopeType: "seat", finding: "hf-1" })).toEqual({ finding: "hf-1" });
    expect(validateHealthSearch({ scopeType: "seat", scopeId: "node_builder2" })).toEqual({ scopeType: "seat", scopeId: "node_builder2" });
    expect(validateConfigurationSearch({ subject: "Avery" })).toEqual({});
    expect(validateForYouSearch({ view: "attention", item: "queue:q 1" })).toEqual({ view: "attention", item: "queue:q 1" });
    expect(validateHealthSearch({ q: "x".repeat(201) })).toEqual({});
  });

  it("fallbacks state what is happening without inferring data", () => {
    render(<OperatorRoutePending label="Health" />);
    expect(screen.getByTestId("operator-route-pending").textContent).toBe("Loading Health…");
    cleanup();
    render(<OperatorRouteError error={new Error("chunk failed")} reset={() => {}} label="Health" info={undefined as never} />);
    expect(screen.getByTestId("operator-route-error").textContent).toMatch(/Health could not be displayed.*chunk failed.*No data was changed/s);
  });
});
