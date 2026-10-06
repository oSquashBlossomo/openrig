// Routed /files journey through the actual FilesRoutePage adapter, a real
// TanStack router with memory history and the actual daemon files routes
// over private temp roots (fictional contents). Exercises root → directory/
// filter → exact source → relative link → anchor → equal filename in a second
// root → Back restoring each location, draft retention across navigation and
// host changes, and the return link. Scroll restoration is router/browser
// behavior (data-scroll-restoration-id) and is left to root's browser pass.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { FilesRoutePage } from "../src/components/files/FilesRoute.js";
import { filesHref, parseFilesLocation } from "../src/components/files/file-source.js";
import { disposeFilesFixtures, filesFixture } from "./files-fixture.js";

afterEach(() => { cleanup(); disposeFilesFixtures(); });

function mountRouted(f: ReturnType<typeof filesFixture>) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/files", component: FilesRoutePage });
  const elsewhere = createRoute({ getParentRoute: () => rootRoute, path: "/elsewhere", component: () => <div data-testid="elsewhere">Project evidence page</div> });
  const router = createRouter({ routeTree: rootRoute.addChildren([filesRoute, elsewhere]), history: createMemoryHistory({ initialEntries: ["/elsewhere"] }) });
  render(<QueryClientProvider client={f.client}><RouterProvider router={router as never} /></QueryClientProvider>);
  const location = () => {
    const href = router.state.location.publicHref ?? router.state.location.href;
    const query = href.includes("?") ? href.slice(href.indexOf("?") + 1).split("#")[0]! : "";
    return { pathname: router.state.location.pathname, ...parseFilesLocation(query) };
  };
  const back = async () => { await act(async () => { router.history.back(); await new Promise((r) => setTimeout(r, 0)); }); };
  return { router, location, back };
}

const roots = {
  alpha: {
    files: {
      "docs/README.md": "# Alpha readme\n\nSee [Guide](guide.md#install).\n",
      "docs/guide.md": "# Guide\n\n[Usage](#usage)\n\n## Install\n\nInstall text.\n\n## Usage\n\nUsage text.\n",
      "docs/notes.txt": "notes\n",
      "other.md": "# Other\n",
    },
  },
  beta: { files: { "README.md": "# Beta readme\n" } },
};

describe("routed Files journey", () => {
  it("root → dir/filter → source → link → anchor → second root → Back restores each step", async () => {
    const f = filesFixture(roots);
    const nav = mountRouted(f);
    await screen.findByTestId("elsewhere");
    await act(async () => { nav.router.history.push(filesHref({ from: "/elsewhere", fromLabel: "Project evidence" })); });
    // Default root is a replace, not a new history entry.
    await waitFor(() => expect(nav.location().root).toBe("alpha"));
    fireEvent.click(await screen.findByTestId("files-entry-docs"));
    await waitFor(() => expect(nav.location().dir).toBe("docs"));
    fireEvent.change(await screen.findByTestId("files-filter"), { target: { value: "read" } });
    await waitFor(() => expect(nav.location().q).toBe("read"));
    expect(screen.queryByTestId("files-entry-docs/guide.md")).toBeNull();
    expect(screen.getByTestId("files-filter-count").textContent).toMatch(/1 of 3/);
    fireEvent.click(screen.getByTestId("files-entry-docs/README.md"));
    expect(await screen.findByRole("heading", { name: "Alpha readme" })).toBeTruthy();
    expect(nav.location()).toMatchObject({ root: "alpha", dir: "docs", q: "read", file: "docs/README.md", from: "/elsewhere" });

    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    expect(await screen.findByText("Install text.")).toBeTruthy();
    expect(nav.location()).toMatchObject({ root: "alpha", file: "docs/guide.md", anchor: "install" });
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    await waitFor(() => expect(nav.location().anchor).toBe("usage"));

    fireEvent.click(screen.getByTestId("files-root-beta"));
    fireEvent.click(await screen.findByTestId("files-entry-README.md"));
    expect(await screen.findByRole("heading", { name: "Beta readme" })).toBeTruthy();
    expect(screen.getByTestId("files-content-path").textContent).toBe("beta/README.md");

    await nav.back();
    await waitFor(() => expect(nav.location()).toMatchObject({ root: "beta" }));
    expect(nav.location().file).toBeUndefined();
    await nav.back();
    await waitFor(() => expect(nav.location()).toMatchObject({ root: "alpha", file: "docs/guide.md", anchor: "usage" }));
    await nav.back();
    await waitFor(() => expect(nav.location().anchor).toBe("install"));
    await nav.back();
    await waitFor(() => expect(nav.location()).toMatchObject({ root: "alpha", dir: "docs", q: "read", file: "docs/README.md" }));
    expect(await screen.findByRole("heading", { name: "Alpha readme" })).toBeTruthy();
    expect((screen.getByTestId("files-filter") as HTMLInputElement).value).toBe("read");
    expect(screen.getByTestId("files-content-path").textContent).toBe("alpha/docs/README.md");

    fireEvent.click(screen.getByTestId("files-return-link"));
    expect(await screen.findByTestId("elsewhere")).toBeTruthy();
    expect(nav.router.state.location.href).toBe("/elsewhere");
    expect(f.writes()).toHaveLength(0);
  });

  it("a draft survives navigation, a host switch and Back without any save or discard", async () => {
    const f = filesFixture(roots);
    const nav = mountRouted(f);
    await act(async () => { nav.router.history.push(filesHref({ root: "alpha", dir: "docs", file: "docs/notes.txt" })); });
    await waitFor(() => expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("files-edit-toggle"));
    fireEvent.change(await screen.findByTestId("files-editor-textarea"), { target: { value: "notes with draft\n" } });

    fireEvent.click(screen.getByTestId("files-entry-docs/README.md"));
    expect(await screen.findByRole("heading", { name: "Alpha readme" })).toBeTruthy();
    expect(screen.getByTestId("files-drafts-toggle").textContent).toMatch(/1 unsaved draft/);
    expect(screen.getByTestId("files-entry-docs/notes.txt").getAttribute("data-draft")).toBe("true");

    act(() => f.setSelected("remote-fixture"));
    expect(await screen.findByTestId("files-blocked")).toBeTruthy();
    act(() => f.setSelected("local"));
    await screen.findByTestId("files-entry-docs/README.md");

    await nav.back();
    const textarea = await screen.findByTestId("files-editor-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("notes with draft\n");
    expect(f.writes()).toHaveLength(0);
  });

  it("an attributed remote origin in the URL never reads local files", async () => {
    const f = filesFixture(roots);
    const nav = mountRouted(f);
    await act(async () => { nav.router.history.push(filesHref({ root: "alpha", file: "other.md", origin: "host-b" })); });
    const blocked = await screen.findByTestId("files-blocked");
    expect(blocked.getAttribute("data-reason")).toBe("remote-origin");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("an unconfigured root in the URL is explicit, not silently replaced", async () => {
    const f = filesFixture(roots);
    const nav = mountRouted(f);
    await act(async () => { nav.router.history.push(filesHref({ root: "gamma", file: "README.md" })); });
    expect(await screen.findByTestId("files-root-missing")).toBeTruthy();
    expect(nav.location().root).toBe("gamma");
    expect(f.calls.some((c) => c.url.startsWith("/api/files/read"))).toBe(false);
  });
});
