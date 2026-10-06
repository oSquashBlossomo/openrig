// Source-aware Files/Markdown reading against the actual daemon files routes
// (private temp roots, fictional contents). Covers origin admission for
// retained/remote/unknown drawers, canonical (symlink) relative resolution,
// percent/Unicode names, nested/duplicate/fenced anchors, read states and
// the drawer Back stack. jsdom does not fetch <img>; asserting no local
// asset URL is emitted is the guard, browser network proof is root's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { rmSync } from "node:fs";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";
import { resolveFileReference, resolveFileAsset, parseFilesLocation, filesHref, type FileSourceFacts } from "../src/components/files/file-source.js";
import { disposeFilesFixtures, filesFixture } from "./files-fixture.js";

afterEach(() => { cleanup(); disposeFilesFixtures(); });

const blue = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>';
const red = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>';

const README = [
  "# Guide",
  "",
  "![figure](figure.svg)",
  "",
  "[Next](next.md) · [Résumé](r%C3%A9sum%C3%A9.md#top) · [Spaced](escaped%20%26%20name.md) · [Deep](sub/deep.md#deep-dive)",
  "",
  "[Ext](https://example.test/doc) [Bad](javascript:alert(1)) [Out](../../outside.md)",
  "",
  "## Setup",
  "",
  "```md",
  "# Setup",
  "```",
  "",
  "~~~",
  "## Setup",
  "~~~",
  "",
  "### Setup",
  "",
  "[second](#setup-1)",
  "",
].join("\n");

function docsRoot() {
  return {
    files: {
      "actual/readme.md": README,
      "actual/figure.svg": blue,
      "actual/next.md": "# Next canonical\n",
      "actual/résumé.md": "# Top\n\nUnicode sibling body.\n",
      "actual/escaped & name.md": "# Spaced\n",
      "actual/sub/deep.md": "# Deep\n\n## Deep Dive\n\nNested body.\n",
      "aliases/figure.svg": red,
      "aliases/next.md": "# Next WRONG alias sibling\n",
      "empty.md": "",
      "blob.bin": Buffer.from([0x41, 0x00, 0xff]),
    },
    symlinks: { "aliases/readme.md": "../actual/readme.md" },
  };
}

function imgParams(img: Element) {
  const u = new URL(img.getAttribute("src")!, "http://private.test/files");
  return { pathname: u.pathname, root: u.searchParams.get("root"), path: u.searchParams.get("path") };
}

describe("pure reference resolution (TUI reading.ts parity)", () => {
  const facts: FileSourceFacts = { target: { originInstance: "local", root: "docs", path: "aliases/readme.md" }, canonicalPath: "actual/readme.md", absolutePath: "/x/actual/readme.md" };
  it.each([
    ["next.md", { kind: "file", path: "actual/next.md" }],
    ["./sub/../next.md#a", { kind: "file", path: "actual/next.md", anchor: "a" }],
    ["r%C3%A9sum%C3%A9.md", { kind: "file", path: "actual/résumé.md" }],
    ["<escaped & name.md> \"title\"", { kind: "file", path: "actual/escaped & name.md" }],
    ["#setup-1", { kind: "anchor", anchor: "setup-1" }],
    ["readme.md#guide", { kind: "anchor", anchor: "guide" }],
    ["https://example.test/x", { kind: "external" }],
    ["mailto:a@example.test", { kind: "unsupported" }],
    ["//evil.test/x", { kind: "unsupported" }],
    ["../../escape.md", { kind: "unsupported" }],
    ["/abs.md", { kind: "unsupported" }],
    ["bad%E0.md", { kind: "unsupported" }],
  ] as const)("%s", (href, expected) => {
    const ref = resolveFileReference(facts, href);
    expect(ref.kind).toBe(expected.kind);
    if (ref.kind === "file") {
      expect(ref.target).toMatchObject({ originInstance: "local", root: "docs", path: (expected as { path: string }).path });
      expect(ref.target.anchor).toBe((expected as { anchor?: string }).anchor);
    }
    if (ref.kind === "anchor") expect(ref.anchor).toBe((expected as { anchor: string }).anchor);
  });

  it("assets join the canonical directory and decode percent names; containment stays server-owned", () => {
    expect(resolveFileAsset(facts, "escaped%20%26%20figure.svg")).toMatchObject({ kind: "local", path: "actual/escaped & figure.svg" });
    expect(resolveFileAsset({ ...facts, canonicalPath: "top.md" }, "a.png")).toMatchObject({ kind: "local", path: "./a.png" });
    expect(resolveFileAsset(facts, "data:image/png;base64,AA")).toMatchObject({ kind: "external" });
  });

  it("/files location round-trips exact strings, rejects unsafe return hrefs", () => {
    const loc = { root: "1.0", dir: "", file: "true", anchor: "a b", q: "x&y", from: "/project/catalog?project=p", fromLabel: "Project" };
    expect(parseFilesLocation(filesHref(loc).split("?")[1]!)).toEqual(loc);
    expect(parseFilesLocation("root=r&from=//evil.test").from).toBeUndefined();
    expect(parseFilesLocation("root=r&project=p").project).toBeUndefined();
  });
});

describe("drawer FileViewer origin admission", () => {
  it("retained local drawer withholds its image after a switch to remote and resumes on local", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="actual/figure.svg" root="docs" kind="image" />);
    expect(imgParams(await screen.findByRole("img"))).toMatchObject({ pathname: "/api/files/asset", root: "docs", path: "actual/figure.svg" });
    const before = f.calls.length;
    act(() => f.setSelected("remote-fixture"));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(screen.getByTestId("file-viewer").getAttribute("data-block-reason")).toBe("selection-remote");
    expect(f.calls.length).toBe(before);
    act(() => f.setSelected("local"));
    expect(imgParams(await screen.findByRole("img")).path).toBe("actual/figure.svg");
  });

  it("a reference opened under a remote selection stays attributed to that host after switching to local", async () => {
    const f = filesFixture({ docs: docsRoot() }, { selected: "remote-fixture" });
    f.mount(<FileViewer path="actual/readme.md" root="docs" kind="markdown" />);
    act(() => f.setSelected("local"));
    await waitFor(() => expect(screen.getByTestId("file-viewer-blocked")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("file-viewer").getAttribute("data-block-reason")).toBe("remote-origin");
    expect(screen.getByTestId("file-viewer-blocked").textContent).toContain("remote-fixture");
    expect(screen.queryByTestId("md-inline-image")).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("explicit remote originInstance never reads local files, even with a local selection", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="actual/readme.md" root="docs" kind="markdown" originInstance="host-b" content="![x](figure.svg) [n](next.md)" />);
    expect(screen.getByTestId("file-viewer").getAttribute("data-block-reason")).toBe("remote-origin");
    expect(screen.getByTestId("file-viewer-inline-excerpt")).toBeTruthy();
    expect(screen.queryByTestId("md-inline-image")).toBeNull();
    expect(screen.getByTestId("md-image-withheld")).toBeTruthy();
    expect(screen.getByTestId("md-inline-link").getAttribute("data-link-kind")).toBe("file-blocked");
    expect(screen.getByTestId("md-inline-link").getAttribute("href")).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("unknown origin is read only after an explicit attribution to the now-known local instance", async () => {
    const f = filesFixture({ docs: docsRoot() }, { selected: undefined });
    f.mount(<FileViewer path="actual/next.md" root="docs" kind="markdown" />);
    expect(screen.getByTestId("file-viewer").getAttribute("data-block-reason")).toBe("unknown-origin");
    act(() => f.setSelected("local"));
    const attribute = await screen.findByTestId("file-viewer-attribute-local");
    expect(f.fetch).not.toHaveBeenCalled();
    fireEvent.click(attribute);
    expect(await screen.findByText("Next canonical")).toBeTruthy();
  });
});

describe("drawer FileViewer source-aware reading", () => {
  it("symlinked source resolves image AND sibling links against the canonical directory", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="aliases/readme.md" root="docs" kind="markdown" />);
    const img = await screen.findByTestId("md-inline-image");
    const served = await f.app.request(new URL(img.getAttribute("src")!, "http://private.test").pathname + new URL(img.getAttribute("src")!, "http://private.test").search);
    expect(await served.text()).toBe(blue);
    expect(screen.getByTestId("file-viewer-canonical-path").textContent).toBe("docs/actual/readme.md");
    const next = screen.getByRole("link", { name: "Next" });
    expect(next.getAttribute("data-target-path")).toBe("actual/next.md");
    fireEvent.click(next);
    expect(await screen.findByText("Next canonical")).toBeTruthy();
    expect(screen.queryByText(/WRONG alias/)).toBeNull();
    // In-drawer Back returns to the source document.
    fireEvent.click(screen.getByTestId("file-viewer-back"));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
  });

  it("percent-encoded Unicode and reserved-character sibling names open exactly", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="actual/readme.md" root="docs" kind="markdown" />);
    fireEvent.click(await screen.findByRole("link", { name: "Résumé" }));
    expect(await screen.findByText("Unicode sibling body.")).toBeTruthy();
    expect(screen.getByTestId("file-viewer-root-path").textContent).toBe("docs/actual/résumé.md");
    fireEvent.click(screen.getByTestId("file-viewer-back"));
    fireEvent.click(await screen.findByRole("link", { name: "Spaced" }));
    expect(await screen.findByRole("heading", { name: "Spaced" })).toBeTruthy();
    expect(f.calls.some((c) => c.url === "/api/files/read?root=docs&path=actual%2Fescaped%20%26%20name.md" && c.status === 200)).toBe(true);
  });

  it("duplicate and nested headings get TUI slugs; fenced pseudo-headings are excluded; anchor links stay in-document", async () => {
    const f = filesFixture({ docs: docsRoot() });
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this.id); });
    f.mount(<FileViewer path="actual/readme.md" root="docs" kind="markdown" />);
    await screen.findByRole("heading", { name: "Guide" });
    const setups = screen.getAllByRole("heading", { name: "Setup" });
    expect(setups.map((h) => h.id)).toEqual(["setup", "setup-1"]);
    expect(screen.getAllByText(/# Setup/).length).toBeGreaterThan(0);
    const second = screen.getByRole("link", { name: "second" });
    expect(second.getAttribute("href")).toBe("#setup-1");
    expect(second.getAttribute("target")).toBeNull();
    fireEvent.click(second);
    expect(scrolled).toContain("setup-1");
    // Cross-document anchor into a nested directory.
    fireEvent.click(screen.getByRole("link", { name: "Deep" }));
    expect(await screen.findByText("Nested body.")).toBeTruthy();
    expect(scrolled).toContain("deep-dive");
  });

  it("external links are explicit new-tab links; unsupported and escaping references are inert", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="actual/readme.md" root="docs" kind="markdown" />);
    const ext = await screen.findByRole("link", { name: "Ext" });
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ext.getAttribute("data-link-kind")).toBe("external");
    expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
    expect(screen.getByText("Bad").getAttribute("data-link-kind")).toBe("unsupported");
    expect(screen.getByText("Out").getAttribute("title")).toMatch(/leaves root/);
  });

  it("distinguishes empty, binary, deleted and failed-refresh reads with served facts", async () => {
    const f = filesFixture({ docs: docsRoot() });
    const { unmount } = f.mount(<FileViewer path="empty.md" root="docs" kind="markdown" />);
    expect(await screen.findByTestId("file-viewer-empty-file")).toBeTruthy();
    expect(screen.getByTestId("file-viewer-facts").getAttribute("data-completeness")).toBe("complete");
    unmount();
    const bin = f.mount(<FileViewer path="blob.bin" root="docs" kind="text" />);
    expect(await screen.findByTestId("file-viewer-binary-read")).toBeTruthy();
    expect(screen.getByTestId("file-viewer-download").getAttribute("href")).toContain("/api/files/asset");
    bin.unmount();
    const next = f.mount(<FileViewer path="actual/next.md" root="docs" kind="markdown" />);
    expect(await screen.findByText("Next canonical")).toBeTruthy();
    rmSync(f.path("docs", "actual/next.md"));
    await act(async () => { await f.client.invalidateQueries({ queryKey: ["files", "read"] }); });
    expect(await screen.findByTestId("file-viewer-refresh-failed")).toBeTruthy();
    expect(screen.getByText("Next canonical")).toBeTruthy();
    next.unmount();
    f.client.clear();
    f.setSelected("local");
    f.mount(<FileViewer path="actual/next.md" root="docs" kind="markdown" />);
    const viewer = await screen.findByTestId("file-viewer");
    await waitFor(() => expect(viewer.getAttribute("data-read-state")).toBe("absent"));
    expect(within(viewer).getByTestId("file-viewer-error").textContent).toMatch(/Deleted or missing/);
  });

  it("truncated reads are labelled as a prefix", async () => {
    const f = filesFixture({ docs: { files: { "big.md": "# Big\n\n" + "x".repeat(1024 * 1024 + 10) } } });
    f.mount(<FileViewer path="big.md" root="docs" kind="markdown" anchor="missing-heading" />);
    expect(await screen.findByTestId("file-viewer-truncated")).toBeTruthy();
    expect(screen.getByTestId("file-viewer-facts").getAttribute("data-completeness")).toBe("truncated");
    expect(screen.getByTestId("md-anchor-missing").textContent).toMatch(/in the returned prefix/);
  });
});

describe("MarkdownViewer without a source keeps legacy behavior", () => {
  it("relative links pass through and assetBasePath still resolves images", () => {
    const md = "[rel](notes.md) ![i](a.png) [h](#x)\n\n# X\n";
    const { container } = render(<MarkdownViewer content={md} assetBasePath="/api/files/asset?root=ws&path=docs" />);
    const links = container.querySelectorAll("[data-testid=md-inline-link]");
    expect(links[0]!.getAttribute("href")).toBe("notes.md");
    expect(links[1]!.getAttribute("href")).toBe("#x");
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/api/files/asset?root=ws&path=docs/a.png");
  });
});

describe("content-only drawer bodies carry their origin admission", () => {
  const LOCAL_ASSET = "/api/files/asset?root=docs&path=actual%2Ffigure.svg";
  const excerpt = `Inline body.\n\n![local](${LOCAL_ASSET}) ![rel](figure.svg) ![ext](https://example.test/x.png)\n\n[sib](next.md)`;

  it("a remote inline Markdown excerpt stays readable but emits no local asset URL or file link", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="remote.md" kind="markdown" originInstance="host-b" content={excerpt} />);
    expect(screen.getByText("Inline body.")).toBeTruthy();
    expect(screen.getByTestId("file-viewer-inline-excerpt")).toBeTruthy();
    const srcs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["https://example.test/x.png"]);
    expect(screen.getAllByTestId("md-image-withheld")).toHaveLength(2);
    expect(screen.getByText("sib").getAttribute("href")).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("known-local inline Markdown keeps its same-origin image; rootless relative refs stay unresolved", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="local.md" kind="markdown" originInstance="local" content={excerpt} />);
    const srcs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([LOCAL_ASSET, "https://example.test/x.png"]);
    expect(screen.getByTestId("md-image-withheld").getAttribute("title")).toMatch(/no file source/);
    expect(screen.getByText("sib").getAttribute("data-link-kind")).toBe("unsupported");
  });

  it("a mounted inline local image follows host changes in both directions", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="inline.svg" kind="image" originInstance="local" imageUrl={LOCAL_ASSET} />);
    expect(document.querySelector("img")).not.toBeNull();
    act(() => f.setSelected("remote-fixture"));
    await waitFor(() => expect(document.querySelector("img")).toBeNull());
    expect(screen.getByTestId("file-viewer-asset-withheld")).toBeTruthy();
    act(() => f.setSelected("local"));
    await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe(LOCAL_ASSET));
  });

  it("a mounted inline Markdown image is withdrawn when the selection becomes remote", async () => {
    const f = filesFixture({ docs: docsRoot() });
    f.mount(<FileViewer path="local.md" kind="markdown" originInstance="local" content={excerpt} />);
    const srcs = () => [...document.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs()).toContain(LOCAL_ASSET);
    act(() => f.setSelected("remote-fixture"));
    await waitFor(() => expect(srcs()).not.toContain(LOCAL_ASSET));
    expect(screen.getByText("Inline body.")).toBeTruthy();
  });

  it("without a QueryClient the selection is unknown: text renders, local URLs are withheld", () => {
    render(<FileViewer path="nc.md" kind="markdown" originInstance="local" content={excerpt} />);
    expect(screen.getByText("Inline body.")).toBeTruthy();
    expect([...document.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://example.test/x.png"]);
    render(<FileViewer path="nc.svg" kind="image" originInstance="local" imageUrl={LOCAL_ASSET} />);
    expect(screen.getByTestId("file-viewer-asset-withheld")).toBeTruthy();
  });

  it("an unattributed inline body opened while the selection is unknown stays withheld after local loads", async () => {
    const f = filesFixture({ docs: docsRoot() }, { selected: undefined });
    f.mount(<FileViewer path="u.svg" kind="image" imageUrl={LOCAL_ASSET} />);
    act(() => f.setSelected("local"));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("a reused content-only viewer attributes each opened item", () => {
  const ASSET = "/api/files/asset?root=docs&path=actual%2Ffigure.svg";
  const img = (alt: string) => document.querySelector(`img[alt="${alt}"]`);
  const control = <FileViewer path="control.svg" kind="image" originInstance="local" imageUrl={ASSET} />;

  it("a new item opened under remote is not admitted by the previous item's local capture", async () => {
    const f = filesFixture({ docs: docsRoot() });
    const view = f.mount(<FileViewer path="first.svg" kind="image" imageUrl={ASSET} />);
    expect(img("first.svg")).not.toBeNull();
    act(() => f.setSelected("remote-fixture"));
    await waitFor(() => expect(img("first.svg")).toBeNull());
    view.rerender(f.wrap(<><FileViewer path="second.svg" kind="image" imageUrl={ASSET} />{control}</>));
    act(() => f.setSelected("local"));
    await waitFor(() => expect(img("control.svg")).not.toBeNull());
    expect(img("second.svg")).toBeNull();
  });

  it("a new item opened under local is admitted even if the previous item was captured remote", async () => {
    const f = filesFixture({ docs: docsRoot() }, { selected: "remote-fixture" });
    const view = f.mount(<FileViewer path="first.svg" kind="image" imageUrl={ASSET} />);
    act(() => f.setSelected("local"));
    await waitFor(() => expect(screen.getByTestId("file-viewer-asset-withheld")).toBeTruthy());
    view.rerender(f.wrap(<FileViewer path="second.svg" kind="image" imageUrl={ASSET} />));
    expect(img("second.svg")).not.toBeNull();
  });

  it("refreshed content of the same item keeps its original capture in both directions", async () => {
    const md = (n: number) => `Body ${n}\n\n![fig](${ASSET})`;
    const f = filesFixture({ docs: docsRoot() });
    const local = f.mount(<FileViewer path="same.md" kind="markdown" content={md(1)} />);
    act(() => f.setSelected("remote-fixture"));
    local.rerender(f.wrap(<FileViewer path="same.md" kind="markdown" content={md(2)} />));
    await waitFor(() => expect(screen.getByText("Body 2")).toBeTruthy());
    expect(img("fig")).toBeNull();
    act(() => f.setSelected("local"));
    await waitFor(() => expect(img("fig")).not.toBeNull());
    local.unmount();

    const g = filesFixture({ docs: docsRoot() }, { selected: "remote-fixture" });
    const remote = g.mount(<FileViewer path="same.md" kind="markdown" content={md(1)} />);
    act(() => g.setSelected("local"));
    remote.rerender(g.wrap(<><FileViewer path="same.md" kind="markdown" content={md(2)} />{control}</>));
    await waitFor(() => expect(img("control.svg")).not.toBeNull());
    expect(screen.getByText("Body 2")).toBeTruthy();
    expect(img("fig")).toBeNull();
  });

  it("an explicit producing origin is kept across reuse", async () => {
    const f = filesFixture({ docs: docsRoot() });
    const view = f.mount(<FileViewer path="a.svg" kind="image" originInstance="host-b" imageUrl={ASSET} />);
    expect(img("a.svg")).toBeNull();
    view.rerender(f.wrap(<FileViewer path="b.svg" kind="image" originInstance="host-b" imageUrl={ASSET} />));
    expect(img("b.svg")).toBeNull();
    view.rerender(f.wrap(<FileViewer path="c.svg" kind="image" originInstance="local" imageUrl={ASSET} />));
    expect(img("c.svg")).not.toBeNull();
  });
});

describe("explicit producing origin is the item's stored attribution", () => {
  const ASSET = "/api/files/asset?root=docs&path=actual%2Ffigure.svg";
  const img = () => document.querySelector('img[alt="same.svg"]');
  const view = (originInstance?: string | null) => (originInstance === undefined
    ? <FileViewer path="same.svg" kind="image" imageUrl={ASSET} />
    : <FileViewer path="same.svg" kind="image" originInstance={originInstance} imageUrl={ASSET} />);

  it.each(["remote-fixture", null] as const)("explicit %s survives a same-item refresh that omits the origin, under local selection", (origin) => {
    const f = filesFixture({ docs: docsRoot() });
    const r = f.mount(view(origin));
    expect(img()).toBeNull();
    r.rerender(f.wrap(view()));
    expect(img()).toBeNull();
    r.rerender(f.wrap(view()));
    expect(img()).toBeNull();
  });

  it("a later explicit value for the same item replaces the stored attribution; omission keeps it", () => {
    const f = filesFixture({ docs: docsRoot() });
    const r = f.mount(view("remote-fixture"));
    r.rerender(f.wrap(view("local")));
    expect(img()).not.toBeNull();
    r.rerender(f.wrap(view()));
    expect(img()).not.toBeNull();
    r.rerender(f.wrap(view(null)));
    expect(img()).toBeNull();
    r.rerender(f.wrap(view()));
    expect(img()).toBeNull();
  });

  it("a new item opened with an explicit remote origin is not admitted by the previous item's local capture", () => {
    const f = filesFixture({ docs: docsRoot() });
    const r = f.mount(<FileViewer path="first.svg" kind="image" imageUrl={ASSET} />);
    expect(document.querySelector('img[alt="first.svg"]')).not.toBeNull();
    r.rerender(f.wrap(<FileViewer path="same.svg" kind="image" originInstance="remote-fixture" imageUrl={ASSET} />));
    expect(img()).toBeNull();
    r.rerender(f.wrap(view()));
    expect(img()).toBeNull();
  });
});
