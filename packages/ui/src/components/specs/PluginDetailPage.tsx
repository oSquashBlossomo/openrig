import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { usePlugin, usePluginUsedBy } from "../../hooks/usePlugins.js";
import { usePluginFilesList, usePluginFilesRead } from "../../hooks/usePluginFiles.js";
import type { FileEntry } from "../../hooks/useFiles.js";
import { DisplayTime } from "../time/DisplayTime.js";
import { classifyLibraryReadError } from "./library-model.js";

// Read-state discipline: each query (detail, used-by, directory, file) is
// shown as cold pending, current success, cold failure, or successful data
// retained behind a newer failed refresh — with its own receipt time. Only the
// detail endpoint's HTTP 404 establishes a missing plugin; other failures are
// "unavailable". Used-by is zero only after a successful empty response.

interface ReadQuery {
  data?: unknown;
  error: unknown;
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: () => unknown;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** When the connected daemon's response was received (not a file time). */
function Received({ at, testId }: { at: number; testId?: string }) {
  return <DisplayTime iso={at ? new Date(at).toISOString() : null} fallback="not yet read" testId={testId} />;
}

function RetryButton({ query, testId }: { query: ReadQuery; testId: string }) {
  return (
    <button type="button" data-testid={testId} disabled={query.isFetching} onClick={() => void query.refetch()}
      className="ml-2 underline decoration-dotted hover:text-on-surface disabled:opacity-50">
      {query.isFetching ? "Retrying…" : "Retry"}
    </button>
  );
}

/** Retained data behind a newer failed read: dated, never presented as current. */
function StaleNotice({ query, what, testId }: { query: ReadQuery; what: string; testId: string }) {
  if (!query.error || query.data === undefined) return null;
  return (
    <div role="status" data-testid={testId} className="border-b border-amber-300 bg-amber-50/70 px-3 py-1.5 font-mono text-[10px] leading-snug text-amber-900">
      Refreshing the {what} failed ({errorText(query.error)}); showing the copy received <Received at={query.dataUpdatedAt} />.
      <RetryButton query={query} testId={`${testId}-retry`} />
    </div>
  );
}

function PageState({ label, description, testId, query }: { label: string; description: ReactNode; testId: string; query?: ReadQuery }) {
  return (
    <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
      <EmptyState label={label} description={description} variant="card" testId={testId} />
      {query && (
        <div className="mt-3 font-mono text-[10px] text-on-surface-variant">
          <RetryButton query={query} testId={`${testId}-retry`} />
        </div>
      )}
    </div>
  );
}


interface PluginDetailPageProps {
  pluginId: string;
}

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".log",
  ".yaml", ".yml", ".json",
  ".js", ".jsx", ".ts", ".tsx",
  ".py", ".sh", ".bash",
  ".css", ".html",
]);

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isMarkdownFile(name: string): boolean {
  const ext = pathExtension(name);
  return ext === ".md" || ext === ".mdx";
}

// Auto-selection priority for the root-level default file: README.md
// at the plugin root if present. Falls back to any other markdown,
// then nothing.
function pickDefaultRootFile(entries: FileEntry[]): string | null {
  const readme = entries.find((e) => e.type === "file" && /^readme\.(md|mdx)$/i.test(e.name));
  if (readme) return readme.name;
  const anyMd = entries.find((e) => e.type === "file" && isMarkdownFile(e.name));
  if (anyMd) return anyMd.name;
  return null;
}

export function PluginDetailPage({ pluginId }: PluginDetailPageProps) {
  const detailQuery = usePlugin(pluginId);
  const usedByQuery = usePluginUsedBy(pluginId);
  const detail = detailQuery.data;
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [defaultPicked, setDefaultPicked] = useState(false);
  const list = usePluginFilesList(pluginId, currentPath);

  // Auto-select README.md (or any markdown) at the plugin root on first load.
  useEffect(() => {
    if (defaultPicked) return;
    if (currentPath !== "") return;
    if (!list.data) return;
    const pick = pickDefaultRootFile(list.data.entries);
    if (pick) setSelectedFile(pick);
    setDefaultPicked(true);
  }, [list.data, currentPath, defaultPicked]);

  if (detail === undefined) {
    if (!detailQuery.error) {
      return <PageState label="LOADING PLUGIN" description="Loading plugin manifest from discovery service." testId="plugin-detail-loading" />;
    }
    // The detail endpoint's 404 is the known missing-target answer; any other
    // failure leaves the plugin's existence unknown.
    return classifyLibraryReadError(detailQuery.error).kind === "absent" ? (
      <PageState
        label="PLUGIN NOT FOUND"
        description="The selected plugin is not visible through any configured discovery source."
        testId="plugin-detail-not-found"
      />
    ) : (
      <PageState
        label="PLUGIN UNAVAILABLE"
        description={`Plugin discovery could not be read (${errorText(detailQuery.error)}), so whether this plugin exists is unknown.`}
        testId="plugin-detail-unavailable"
        query={detailQuery}
      />
    );
  }

  const entry = detail.entry;
  const skillCount = entry.skillCount;
  const detailNowMissing = detailQuery.error !== null && classifyLibraryReadError(detailQuery.error).kind === "absent";

  return (
    <div
      data-testid="plugin-detail-page"
      className="h-full overflow-hidden bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4">
        <SectionHeader tone="muted">Plugin</SectionHeader>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
            {entry.name}
          </h1>
          <span className="font-mono text-sm text-on-surface-variant">v{entry.version}</span>
          {entry.runtimes.map((rt) => (
            <span
              key={rt}
              data-testid={`plugin-detail-runtime-${rt}`}
              className="inline-block border border-outline-variant bg-surface-lowest/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface"
            >
              {rt}
            </span>
          ))}
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
            title={entry.path}
          >
            {entry.sourceLabel}
          </span>
          <span
            data-testid="plugin-detail-skill-count"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
          >
            {skillCount} {skillCount === 1 ? "skill" : "skills"}
          </span>
          <UsedByCount query={usedByQuery} />
        </div>
        {entry.description && (
          <p className="mt-2 max-w-3xl text-sm text-on-surface-variant">{entry.description}</p>
        )}
        <div data-testid="plugin-detail-read" className="mt-1 font-mono text-[10px] text-on-surface-variant">
          Details received from the connected daemon <Received at={detailQuery.dataUpdatedAt} />
          {" · "}last seen by discovery <DisplayTime iso={entry.lastSeenAt} fallback="not reported" />
        </div>
      </header>
      {detailNowMissing ? (
        <div role="status" data-testid="plugin-detail-stale" className="border-b border-amber-300 bg-amber-50/70 px-3 py-1.5 font-mono text-[10px] leading-snug text-amber-900">
          The latest read reports this plugin as not found; showing the details received <Received at={detailQuery.dataUpdatedAt} />.
          <RetryButton query={detailQuery} testId="plugin-detail-stale-retry" />
        </div>
      ) : (
        <StaleNotice query={detailQuery} what="plugin details" testId="plugin-detail-stale" />
      )}

      <div
        data-testid="plugin-detail-docs-browser"
        className="flex h-[calc(100%-7rem)] flex-col border border-outline-variant bg-surface-lowest/25 hard-shadow sm:flex-row"
      >
        <aside
          data-testid="plugin-detail-tree"
          className="w-full max-h-64 shrink-0 overflow-y-auto border-b border-outline-variant bg-surface-lowest/30 sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r"
        >
          <Breadcrumbs
            testId="plugin-detail-breadcrumbs"
            pluginName={entry.name}
            path={currentPath}
            onNavigate={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
          />
          <StaleNotice query={list} what="directory listing" testId="plugin-detail-tree-stale" />
          {list.data === undefined && list.error ? (
            <div role="alert" data-testid="plugin-detail-tree-error" className="p-3 font-mono text-[10px] text-red-600">
              Directory unavailable: {errorText(list.error)}. Its contents are unknown.
              <RetryButton query={list} testId="plugin-detail-tree-retry" />
            </div>
          ) : list.data === undefined ? (
            <div data-testid="plugin-detail-tree-loading" className="p-3 font-mono text-[10px] text-on-surface-variant">
              Loading…
            </div>
          ) : list.data.entries.length === 0 ? (
            <div data-testid="plugin-detail-tree-empty" className="p-3 font-mono text-[10px] text-on-surface-variant">
              Empty directory.
            </div>
          ) : (
            <ul className="p-1">
              {currentPath && (
                <li>
                  <button
                    type="button"
                    data-testid="plugin-detail-tree-up"
                    onClick={() => { setCurrentPath(parentPath(currentPath)); setSelectedFile(null); }}
                    className="block w-full px-2 py-1 text-left font-mono text-[10px] text-on-surface-variant hover:bg-surface-low"
                  >
                    ..
                  </button>
                </li>
              )}
              {list.data.entries.map((fileEntry) => {
                const rel = joinPath(currentPath, fileEntry.name);
                const isFile = fileEntry.type === "file";
                const isSelected = selectedFile === rel;
                return (
                  <li key={rel}>
                    <button
                      type="button"
                      data-testid={`plugin-detail-tree-entry-${rel}`}
                      data-type={fileEntry.type}
                      data-active={isSelected}
                      onClick={() => {
                        if (isFile) setSelectedFile(rel);
                        else if (fileEntry.type === "dir") { setCurrentPath(rel); setSelectedFile(null); }
                      }}
                      disabled={fileEntry.type === "other"}
                      className={`block w-full px-2 py-1 text-left font-mono text-[10px] ${
                        fileEntry.type === "other"
                          ? "text-on-surface-variant"
                          : `hover:bg-surface-low ${isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface"}`
                      }`}
                    >
                      {fileEntry.type === "dir" ? `▸ ${fileEntry.name}` : fileEntry.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main data-testid="plugin-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest">
          {!selectedFile ? (
            <div data-testid="plugin-detail-viewer-no-selection" className="p-4 font-mono text-[10px] text-on-surface-variant">
              Select a file from the tree.
            </div>
          ) : (
            <PluginFileContent pluginId={pluginId} path={selectedFile} />
          )}
        </main>
      </div>
    </div>
  );
}

function Breadcrumbs({
  testId,
  pluginName,
  path,
  onNavigate,
}: {
  testId: string;
  pluginName: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid={testId} className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-on-surface">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">
        {pluginName}
      </button>
      {segments.map((seg, idx) => {
        const accumulated = segments.slice(0, idx + 1).join("/");
        return (
          <span key={accumulated}>
            <span className="mx-0.5 text-on-surface-variant">/</span>
            <button type="button" onClick={() => onNavigate(accumulated)} className="hover:underline">
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function PluginFileContent({ pluginId, path }: { pluginId: string; path: string }) {
  const read = usePluginFilesRead(pluginId, path);
  const ext = useMemo(() => pathExtension(path), [path]);

  if (read.data === undefined) {
    return read.error ? (
      <div role="alert" data-testid="plugin-detail-viewer-error" className="p-4 font-mono text-[10px] text-red-600">
        File unavailable: {errorText(read.error)}.
        <RetryButton query={read} testId="plugin-detail-viewer-retry" />
      </div>
    ) : (
      <div data-testid="plugin-detail-viewer-loading" className="p-4 font-mono text-[10px] text-on-surface-variant">
        Loading…
      </div>
    );
  }

  return (
    <div data-testid="plugin-detail-viewer-content" className="flex h-full flex-col">
      <StaleNotice query={read} what="file" testId="plugin-detail-viewer-stale" />
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2 font-mono text-[10px]">
        <div data-testid="plugin-detail-viewer-path" className="text-on-surface">{path}</div>
        <div className="flex items-baseline gap-3 text-on-surface-variant">
          <span>{read.data.size}b</span>
          <span data-testid="plugin-detail-viewer-mtime">modified <DisplayTime iso={read.data.mtime} /></span>
          <span data-testid="plugin-detail-viewer-read">read <Received at={read.dataUpdatedAt} /></span>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.data.truncated && (
          <div
            data-testid="plugin-detail-viewer-truncated"
            className="mb-3 mx-4 mt-4 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
          >
            ⚠ Truncated at {Math.round((read.data.truncatedAtBytes ?? 0) / 1024)} KB — file is{" "}
            {Math.round((read.data.totalBytes ?? read.data.size) / 1024)} KB total.
          </div>
        )}
        {ext === ".md" || ext === ".mdx" ? (
          <div className="p-4">
            <MarkdownViewer content={read.data.content} />
          </div>
        ) : TEXT_LIKE_EXTENSIONS.has(ext) ? (
          <div className="p-4">
            <SyntaxHighlight code={read.data.content} language={ext.slice(1)} />
          </div>
        ) : (
          <pre data-testid="plugin-detail-viewer-text-fallback" className="p-4 whitespace-pre-wrap break-words font-mono text-[10px] text-on-surface">
            {read.data.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Agents whose specs reference this plugin. Zero only from a successful
 * empty response; pending/failed is unknown; a retained count is dated. */
function UsedByCount({ query }: { query: ReturnType<typeof usePluginUsedBy> }) {
  const className = "font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant";
  const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  if (query.data === undefined) {
    return query.error ? (
      <span data-testid="plugin-detail-used-by-count" data-state="unavailable" className={`${className} text-red-700`} title={errorText(query.error)}>
        used by: unknown (read failed)
        <RetryButton query={query} testId="plugin-detail-used-by-retry" />
      </span>
    ) : (
      <span data-testid="plugin-detail-used-by-count" data-state="pending" className={className}>used by: reading…</span>
    );
  }
  if (query.error) {
    return (
      <span data-testid="plugin-detail-used-by-count" data-state="stale" className={`${className} text-amber-800`} title={errorText(query.error)}>
        used by {agents(query.data.length)} as of <Received at={query.dataUpdatedAt} /> (refresh failed)
        <RetryButton query={query} testId="plugin-detail-used-by-retry" />
      </span>
    );
  }
  return (
    <span data-testid="plugin-detail-used-by-count" data-state="current" className={className}>
      used by {agents(query.data.length)}
    </span>
  );
}
