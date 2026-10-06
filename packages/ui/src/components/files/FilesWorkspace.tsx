// UI Enhancement Pack v0 — Files browser workspace.
//
// Top-level center-workspace surface for /files route. Two-pane shape:
//   - Left: allowlist root selector + directory filter + tree of the root.
//   - Right: file content panel (markdown via MarkdownViewer, code via
//     SyntaxHighlight, images inline, other → "view as text" affordance).
//
// Location (root, dir, filter, file, anchor, attribution, return link) is a
// FilesLocation. Routed through FilesRoute it lives in the URL, so each
// choice is a history entry and browser Back restores source/root/anchor/
// filter; scroll is restored per entry by the router (data-scroll-
// restoration-id). Mounted without a location (tests, embeds) it keeps the
// same state internally. Drafts are never put in the location.
//
// Local-only: /api/files has no remote forwarding. The workspace reads only
// when its origin (explicit ?origin= or the known selection) and the known
// selection are the connected local instance. Relative Markdown links and
// images resolve against the served canonical source (resolvedPath).
//
// Item 4 (edit mode): FileEditor (see FileEditor.tsx) — whole-file CAS save,
// line-ending-preserving serialization, retained drafts and 409 conflicts.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  fileAssetUrl,
  FilesReadError,
  useFilesList,
  useFilesRead,
  useFilesRoots,
  type AllowlistRoot,
  type FileEntry,
  type FilesReadResponse,
} from "../../hooks/useFiles.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { useSpecReview } from "../../hooks/useSteering.js";
import { useWorkspace } from "../../hooks/useWorkspace.js";
import { WorkspaceKindBadge, resolveKindForPath } from "../WorkspaceKindBadge.js";
import {
  fileOriginAdmission,
  fileTargetKey,
  parentPath,
  sourceFactsFromRead,
  type FileOriginAdmission,
  type FileSourceTarget,
  type FilesLocation,
} from "./file-source.js";
import { useKnownSelectedHost } from "./useFileAdmission.js";
import { isDraftDirty, useFileDraft, useFileDraftStore, useFileDrafts, type FileDraft } from "./file-drafts.js";
import { FileReadFacts } from "./FileReadFacts.js";
import { assessFileEditability, EditUnavailableNotice, FileEditor, RetainedDraftNotice } from "./FileEditor.js";

export { assessFileEditability, FileEditor, type FileEditability } from "./FileEditor.js";

const TEXT_LIKE_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".json", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".sql", ".css", ".html"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const DOWNLOAD_ONLY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".pdf", ".mp4", ".webm", ".mov"]);

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export type FilesNavigate = (next: FilesLocation, options?: { replace?: boolean }) => void;

export interface FilesWorkspaceProps {
  /** Controlled location (FilesRoute). Omit for internal state. */
  location?: FilesLocation;
  onNavigate?: FilesNavigate;
}

/** Attribution/return fields that persist across in-workspace navigation. */
function carried(location: FilesLocation): FilesLocation {
  const out: FilesLocation = {};
  for (const key of ["origin", "project", "projectRoot", "from", "fromLabel"] as const) {
    if (location[key] !== undefined) out[key] = location[key];
  }
  return out;
}

export function FilesWorkspace({ location: controlled, onNavigate }: FilesWorkspaceProps = {}) {
  const [internal, setInternal] = useState<FilesLocation>({});
  const location = controlled ?? internal;
  const contentRef = useRef<HTMLElement>(null);
  const go: FilesNavigate = (next, options) => {
    // A pushed entry for a different file starts at the top; Back restores
    // the previous entry's scroll through the router.
    if (!options?.replace && (next.file !== location.file || next.root !== location.root)) {
      const el = contentRef.current;
      if (el) el.scrollTop = 0;
    }
    if (onNavigate) onNavigate(next, options);
    else setInternal(next);
  };
  const known = useKnownSelectedHost();
  const origin = location.origin ?? known ?? null;
  const admission = fileOriginAdmission(origin, known);
  const project = location.project !== undefined && location.projectRoot !== undefined
    ? { projectId: location.project, projectRoot: location.projectRoot }
    : undefined;
  const roots = useFilesRoots({ enabled: admission.admitted });
  const workspace = useWorkspace();
  const keep = carried(location);
  const selectedRoot = location.root ?? null;
  const currentPath = location.dir ?? (location.file ? parentPath(location.file) : "");
  const selectedFile = location.file ?? null;
  const rootList = roots.data && !isUnavailable(roots.data) ? roots.data.roots : null;
  // A URL-provided root is read only after the served roots confirm it.
  const rootConfigured = !!selectedRoot && !!rootList && rootList.some((r) => r.name === selectedRoot);
  const rootMissing = !!selectedRoot && !!rootList && !rootConfigured;

  // Default-select the first root once roots arrive (replace: not a choice).
  useEffect(() => {
    if (selectedRoot || !admission.admitted || !rootList) return;
    const first = rootList[0];
    if (first) go({ ...keep, root: first.name, dir: "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootList, selectedRoot, admission.admitted]);

  return (
    <div data-testid="files-workspace" className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-outline-variant bg-background px-4 py-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">Workspace</div>
          <h1 className="font-headline text-xl font-bold tracking-tight text-on-surface">Files</h1>
          {project && (
            <div data-testid="files-project" className="mt-0.5 font-mono text-[10px] text-on-surface-variant break-all">
              project {project.projectId} · {project.projectRoot}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {location.from && <ReturnLink href={location.from} label={location.fromLabel} />}
          <DraftsMenu origin={origin} onOpen={(draft) => go({ ...keep, root: draft.root, dir: parentPath(draft.path), file: draft.path })} />
        </div>
      </header>
      {!admission.admitted ? (
        <BlockedWorkspace admission={admission} />
      ) : (
        <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
          {/* Slice 20 mobile: at narrow viewports the two-pane shape stacks
              vertically so the document panel claims full width on a phone.
              Tree pane caps at max-h-48 on mobile so the user can scroll past
              it to the content. Desktop (sm:) layout: 288px tree column. */}
          <aside data-testid="files-tree-pane" data-scroll-restoration-id="files-tree" className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-background sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r">
            <RootSelector
              roots={roots.data}
              isLoading={roots.isLoading}
              error={roots.isError ? (roots.error as Error) : null}
              onRetry={() => void roots.refetch()}
              selectedRoot={selectedRoot}
              onSelect={(name) => go({ ...keep, root: name, dir: "" })}
              workspace={workspace.data ?? null}
            />
            {selectedRoot && rootConfigured && (
              <>
                <Breadcrumbs root={selectedRoot} path={currentPath} onNavigate={(dir) => go({ ...keep, root: selectedRoot, dir })} />
                <DirectoryFilter
                  value={location.q ?? ""}
                  onChange={(q) => go({ ...location, q: q || undefined }, { replace: true })}
                />
                <DirectoryTree
                  root={selectedRoot}
                  path={currentPath}
                  filter={location.q ?? ""}
                  origin={origin}
                  onEnterDir={(rel) => go({ ...keep, root: selectedRoot, dir: rel })}
                  onSelectFile={(rel) => go({ ...keep, root: selectedRoot, dir: currentPath, ...(location.q ? { q: location.q } : {}), file: rel })}
                  selectedFile={selectedFile}
                />
              </>
            )}
          </aside>
          <main ref={contentRef} data-testid="files-content-pane" data-scroll-restoration-id="files-content" className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest">
            {!selectedRoot && (
              <div className="m-auto p-4 font-mono text-[10px] text-on-surface-variant">
                Select an allowlist root to browse.
              </div>
            )}
            {selectedRoot && !rootList && (
              <div data-testid="files-root-pending" className="p-4 font-mono text-[10px] text-on-surface-variant">
                Confirming root “{selectedRoot}” on the connected instance…
              </div>
            )}
            {rootMissing && (
              <div data-testid="files-root-missing" role="alert" className="m-4 border border-red-300 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
                Root “{selectedRoot}” is not configured on the connected instance. Nothing was read; choose a listed root.
              </div>
            )}
            {selectedRoot && rootConfigured && !selectedFile && (
              <div className="p-4 font-mono text-[10px] text-on-surface-variant" data-testid="files-no-selection">
                Select a file from the tree.
              </div>
            )}
            {selectedRoot && rootConfigured && selectedFile && (
              <FileContentPanel
                key={`${selectedRoot}\u0000${selectedFile}`}
                target={{ originInstance: origin, root: selectedRoot, path: selectedFile, ...(location.anchor ? { anchor: location.anchor } : {}), ...(project ? { project } : {}) }}
                onOpenTarget={(target) => go({ ...keep, root: target.root, dir: parentPath(target.path), file: target.path, ...(target.anchor ? { anchor: target.anchor } : {}) })}
                onAnchor={(anchor) => go({ ...location, anchor })}
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function ReturnLink({ href, label }: { href: string; label?: string }) {
  const router = useRouter({ warn: false });
  return (
    <a
      data-testid="files-return-link"
      href={href}
      onClick={(e) => {
        if (!router || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        router.history.push(href);
      }}
      className="touch-target inline-flex items-center border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface hover:bg-surface-low"
    >
      ← {label ?? "return"}
    </a>
  );
}

function DraftsMenu({ origin, onOpen }: { origin: string | null; onOpen: (draft: FileDraft) => void }) {
  const store = useFileDraftStore();
  const drafts = useFileDrafts(store).filter((d) => isDraftDirty(d) || d.conflict);
  const [open, setOpen] = useState(false);
  if (drafts.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="files-drafts-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="touch-target border border-amber-400 bg-amber-50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.10em] text-amber-900"
      >
        {drafts.length} unsaved draft{drafts.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul data-testid="files-drafts-list" className="absolute right-0 z-10 mt-1 w-72 max-w-[90vw] border border-outline-variant bg-background p-1 shadow">
          {drafts.map((d) => (
            <li key={d.key}>
              {d.originInstance === origin ? (
                <button type="button" onClick={() => { setOpen(false); onOpen(d); }} className="touch-target block w-full px-2 py-1 text-left font-mono text-[10px] text-on-surface hover:bg-surface-low break-all">
                  {d.root}/{d.path}{d.conflict ? " · conflict" : ""}
                </button>
              ) : (
                <span className="block px-2 py-1 font-mono text-[10px] text-on-surface-variant break-all">
                  {d.root}/{d.path} · kept for {d.originInstance ?? "unknown instance"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BlockedWorkspace({ admission }: { admission: Extract<FileOriginAdmission, { admitted: false }> }) {
  return (
    <div data-testid="files-blocked" data-reason={admission.reason} role="status" className="m-4 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-900">
      {admission.message}
      <div className="mt-1 text-amber-900/80">Unsaved drafts stay in this tab and are not saved or discarded while Files is unavailable.</div>
    </div>
  );
}

function RootSelector({
  roots,
  isLoading,
  error,
  onRetry,
  selectedRoot,
  onSelect,
  workspace,
}: {
  roots: ReturnType<typeof useFilesRoots>["data"] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  selectedRoot: string | null;
  onSelect: (name: string) => void;
  workspace: import("../../hooks/useWorkspace.js").WhoamiWorkspaceUI | null;
}) {
  if (isLoading) return <div className="p-3 font-mono text-[10px] text-on-surface-variant">Loading roots…</div>;
  if (error && !roots) {
    return (
      <div data-testid="files-roots-error" role="alert" className="p-3 font-mono text-[10px] text-red-700">
        <div>Could not read file roots: {error.message}</div>
        <button type="button" onClick={onRetry} className="touch-target mt-1 underline">retry</button>
      </div>
    );
  }
  if (!roots) return null;
  if (isUnavailable(roots)) {
    return (
      <div data-testid="files-roots-unavailable" className="p-3 font-mono text-[10px] text-on-surface-variant">
        <div>Files routes unavailable.</div>
        {roots.hint && <div className="mt-1 text-on-surface-variant">{roots.hint}</div>}
      </div>
    );
  }
  if (roots.roots.length === 0) {
    return (
      <div data-testid="files-roots-empty" className="p-3 font-mono text-[10px] text-on-surface-variant">
        <div>No allowlist roots configured.</div>
        {roots.hint && <div className="mt-1 text-on-surface-variant">{roots.hint}</div>}
      </div>
    );
  }
  return (
    <div data-testid="files-root-selector" className="border-b border-outline-variant p-2">
      <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">Roots</div>
      <ul>
        {roots.roots.map((r: AllowlistRoot) => {
          const kind = resolveKindForPath(r.path, workspace);
          return (
            <li key={r.name}>
              <button
                type="button"
                data-testid={`files-root-${r.name}`}
                data-active={selectedRoot === r.name}
                aria-current={selectedRoot === r.name ? "true" : undefined}
                onClick={() => onSelect(r.name)}
                className={`touch-target flex w-full items-center justify-between gap-2 px-2 py-1 text-left font-mono text-[11px] hover:bg-surface-low ${
                  selectedRoot === r.name ? "bg-surface-high/80 text-on-surface" : "text-on-surface"
                }`}
                title={r.path}
              >
                <span className="truncate">{r.name}</span>
                {kind && <WorkspaceKindBadge kind={kind} compact />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Breadcrumbs({ root, path, onNavigate }: { root: string; path: string; onNavigate: (path: string) => void }) {
  const segments = path ? path.split("/") : [];
  return (
    <nav aria-label="Directory" data-testid="files-breadcrumbs" className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-on-surface">
      <button type="button" onClick={() => onNavigate("")} className="touch-target font-bold hover:underline">{root}</button>
      {segments.map((seg, idx) => {
        const accumulated = segments.slice(0, idx + 1).join("/");
        return (
          <span key={accumulated}>
            <span className="mx-0.5 text-on-surface-variant">/</span>
            <button type="button" onClick={() => onNavigate(accumulated)} className="touch-target hover:underline">
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function DirectoryFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="border-b border-outline-variant px-2 py-1.5">
      <label className="block font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant" htmlFor="files-filter-input">
        Filter this directory
      </label>
      <input
        id="files-filter-input"
        data-testid="files-filter"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="name contains…"
        className="touch-target touch-text mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[11px] text-on-surface"
      />
    </div>
  );
}

function DirectoryTree({
  root,
  path,
  filter,
  origin,
  onEnterDir,
  onSelectFile,
  selectedFile,
}: {
  root: string;
  path: string;
  filter: string;
  origin: string | null;
  onEnterDir: (rel: string) => void;
  onSelectFile: (rel: string) => void;
  selectedFile: string | null;
}) {
  const list = useFilesList(root, path);
  const store = useFileDraftStore();
  const drafts = useFileDrafts(store);
  if (list.isLoading) return <div className="p-3 font-mono text-[10px] text-on-surface-variant">Loading…</div>;
  if (list.isError && !list.data) {
    const absent = list.error instanceof FilesReadError && list.error.code === "absent";
    return (
      <div data-testid="files-list-error" role="alert" className="p-3 font-mono text-[10px] text-red-600">
        {absent ? `Directory ${root}/${path} was not found on disk.` : (list.error as Error)?.message ?? "Error loading directory."}
      </div>
    );
  }
  const entries = list.data?.entries ?? [];
  const needle = filter.toLocaleLowerCase();
  const shown = needle ? entries.filter((e) => e.name.toLocaleLowerCase().includes(needle)) : entries;
  const draftPaths = new Set(drafts.filter((d) => d.originInstance === origin && d.root === root && (isDraftDirty(d) || d.conflict)).map((d) => d.path));
  return (
    <>
      {list.isError && (
        <div data-testid="files-list-refresh-failed" role="status" className="px-3 pt-2 font-mono text-[9px] text-red-700">
          Refresh failed; showing the last listing.
        </div>
      )}
      {entries.length === 0 && !path && (
        <div className="p-3 font-mono text-[10px] text-on-surface-variant">Empty directory.</div>
      )}
      {needle && (
        <div data-testid="files-filter-count" role="status" className="px-3 pt-2 font-mono text-[9px] text-on-surface-variant">
          {shown.length} of {entries.length} entries match “{filter}”
        </div>
      )}
      <ul data-testid="files-directory-tree" className="p-1">
        {path && (
          <li>
            <button
              type="button"
              data-testid="files-up"
              onClick={() => onEnterDir(parentPath(path))}
              className="touch-target block w-full px-2 py-1 text-left font-mono text-[11px] text-on-surface-variant hover:bg-surface-low"
            >
              ..
            </button>
          </li>
        )}
        {entries.length === 0 && path && (
          <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant">Empty directory.</li>
        )}
        {shown.map((entry: FileEntry) => {
          const rel = path ? `${path}/${entry.name}` : entry.name;
          const isFile = entry.type === "file";
          const isSelected = selectedFile === rel;
          return (
            <li key={rel}>
              <button
                type="button"
                data-testid={`files-entry-${rel}`}
                data-type={entry.type}
                data-draft={draftPaths.has(rel) || undefined}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => isFile ? onSelectFile(rel) : entry.type === "dir" ? onEnterDir(rel) : undefined}
                disabled={entry.type === "other"}
                className={`touch-target block w-full px-2 py-1 text-left font-mono text-[11px] ${
                  entry.type === "other"
                    ? "text-on-surface-variant"
                    : `hover:bg-surface-low ${isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface"}`
                } ${draftPaths.has(rel) ? "italic text-amber-800" : ""}`}
              >
                {entry.type === "dir" ? `▸ ${entry.name}` : entry.name}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function FileContentPanel({
  target,
  onOpenTarget,
  onAnchor,
}: {
  target: FileSourceTarget;
  onOpenTarget: (target: FileSourceTarget) => void;
  onAnchor: (anchor: string) => void;
}) {
  const { root, path } = target;
  const read = useFilesRead(root, path);
  const store = useFileDraftStore();
  const draftKey = fileTargetKey(target);
  const draft = useFileDraft(store, draftKey);
  const hasDraft = !!draft && (isDraftDirty(draft) || !!draft.conflict);
  const editability = useMemo(() => (read.data ? assessFileEditability(read.data) : null), [read.data]);
  const canEdit = editability?.editable === true;
  // A retained draft reopens its editor when the operator returns to it.
  const [editMode, setEditMode] = useState<boolean>(hasDraft);
  const editing = editMode && canEdit;
  // A refetch can turn an editable read into an unsafe one (file grew past
  // the cap, became binary). Leave edit mode; any draft stays retained.
  useEffect(() => {
    if (editMode && editability && !editability.editable) setEditMode(false);
  }, [editMode, editability]);
  const failure = read.isError ? readFailure(read.error) : null;
  return (
    <div data-testid="files-content-panel" data-read-state={!read.data ? (failure ? failure.reason : "loading") : failure ? "refresh-failed" : "current"} className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px]">
        <div className="min-w-0 break-all text-on-surface" data-testid="files-content-path">{root}/{path}</div>
        <div className="flex items-center gap-3 text-on-surface-variant">
          {read.data && (
            <>
              <span data-testid="files-content-size">{read.data.size}b</span>
              <span data-testid="files-content-mtime">{read.data.mtime}</span>
            </>
          )}
          <button
            type="button"
            data-testid="files-edit-toggle"
            data-active={editing}
            data-editable={canEdit}
            aria-pressed={editing}
            disabled={!canEdit}
            title={editability && !editability.editable ? `Read-only: ${editability.detail}` : undefined}
            onClick={() => setEditMode(!editing)}
            className={`touch-target border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] disabled:cursor-not-allowed disabled:opacity-50 ${
              editing
                ? "border-amber-400 bg-amber-50 text-amber-900"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            {editing ? "editing" : "edit"}
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.isLoading && <div className="p-4 font-mono text-[10px] text-on-surface-variant">Loading…</div>}
        {failure && !read.data && (
          <div data-testid="files-read-error" data-reason={failure.reason} role="alert" className="m-4 border border-red-300 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
            {failure.text}
          </div>
        )}
        {failure && read.data && (
          <div data-testid="files-read-refresh-failed" role="alert" className="mx-4 mt-3 border border-red-300 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
            Refresh failed ({failure.text}). Showing the last successful read from {new Date(read.dataUpdatedAt).toISOString()}.
          </div>
        )}
        {hasDraft && !editing && (
          <RetainedDraftNotice draft={draft!} onResume={canEdit ? () => setEditMode(true) : undefined} onDiscard={() => store.delete(draftKey)} />
        )}
        {read.data && (
          editing
            ? <FileEditor root={root} path={path} read={read.data} originInstance={target.originInstance} />
            : (
              <>
                {editability && !editability.editable && <EditUnavailableNotice editability={editability} />}
                <FileReadFacts read={read.data} target={target} testIdPrefix="files" />
                <FileBody target={target} read={read.data} onOpenTarget={onOpenTarget} onAnchor={onAnchor} />
              </>
            )
        )}
      </div>
    </div>
  );
}

function readFailure(error: unknown): { reason: "absent" | "bad_path" | "read_error"; text: string } {
  if (error instanceof FilesReadError) {
    if (error.code === "absent") return { reason: "absent", text: "Deleted or missing: this file is no longer on disk. Nothing else was substituted." };
    if (error.code === "bad_path") return { reason: "bad_path", text: "The path is invalid or outside its root." };
  }
  return { reason: "read_error", text: (error as Error)?.message ?? "Error loading file." };
}

function FileBody({ target, read, onOpenTarget, onAnchor }: {
  target: FileSourceTarget;
  read: FilesReadResponse;
  onOpenTarget: (target: FileSourceTarget) => void;
  onAnchor: (anchor: string) => void;
}) {
  const { root, path } = target;
  const ext = pathExtension(path);
  // OSR v0 item 3: detect spec-kind YAML files for inline validation.
  const specKind = detectSpecKind(path);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-image-view" className="p-4">
        <TruncationMarker read={read} />
        <img src={fileAssetUrl(root, path)} alt={path} className="max-w-full border border-outline-variant" />
      </div>
    );
  }
  if (DOWNLOAD_ONLY_EXTENSIONS.has(ext) || read.binary === true) {
    return (
      <div data-testid="files-download-only" className="p-4 font-mono text-[10px] text-on-surface">
        {read.binary === true && (
          <p data-testid="files-binary-notice" className="mb-2 text-on-surface-variant">
            Binary or non-UTF-8 file; text is not displayed.
          </p>
        )}
        <a href={fileAssetUrl(root, path)} download className="text-blue-700 underline">
          Download {path}
        </a>
      </div>
    );
  }
  if (read.content === "") {
    return (
      <div data-testid="files-empty-file" role="status" className="p-4 font-mono text-[10px] text-on-surface-variant">
        Empty file — the read completed with 0 bytes.
      </div>
    );
  }
  if (ext === ".md") {
    return (
      <div className="p-4">
        <TruncationMarker read={read} />
        <MarkdownViewer
          content={read.content}
          source={{ facts: sourceFactsFromRead(target, read), admitted: true, truncated: read.truncated === true }}
          anchor={target.anchor}
          onOpenFile={onOpenTarget}
          onAnchorChange={(anchor) => { if (anchor !== target.anchor) onAnchor(anchor); }}
        />
      </div>
    );
  }
  if (TEXT_LIKE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-code-view" className="p-4">
        <TruncationMarker read={read} />
        {specKind && <SpecValidationPanel kind={specKind} yaml={read.content} />}
        <SyntaxHighlight code={read.content} language={ext.slice(1)} />
      </div>
    );
  }
  return (
    <div data-testid="files-text-fallback" className="p-4">
      <TruncationMarker read={read} />
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-on-surface">{read.content}</pre>
    </div>
  );
}

// Operator Surface Reconciliation v0 item 5: explicit truncation marker
// rendered above the file body when the daemon capped the read at
// FILE_READ_TRUNCATION_BYTES (1 MB). Honest about the limit so the
// operator knows to use an external editor for full content.
function TruncationMarker({ read }: { read: FilesReadResponse }) {
  if (!read.truncated) return null;
  const totalKb = Math.round((read.totalBytes ?? read.size) / 1024);
  return (
    <div
      data-testid="files-truncation-marker"
      data-truncated-at-bytes={read.truncatedAtBytes ?? ""}
      data-total-bytes={read.totalBytes ?? ""}
      className="mb-3 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
    >
      ⚠ Truncated by file viewer at {Math.round((read.truncatedAtBytes ?? 0) / 1024)} KB —
      file is {totalKb} KB total. Use an external editor for full content.
    </div>
  );
}

// OSR v0 item 3: RigSpec / AgentSpec validation panel. Detects spec
// kind by filename and invokes the existing /api/specs/review/{rig|agent}
// endpoint via the useSpecReview hook. Errors / warnings render inline
// alongside the YAML view; non-spec YAML files don't surface this
// panel at all.
function detectSpecKind(filePath: string): "rig" | "agent" | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("/rig.yaml") || lower === "rig.yaml" || lower.endsWith("/rig.yml") || lower === "rig.yml") return "rig";
  if (lower.endsWith("/agent.yaml") || lower === "agent.yaml" || lower.endsWith("/agent.yml") || lower === "agent.yml") return "agent";
  // Spec library entries: <pkg>/specs/<spec-name>/{rig,agent}.yaml shape;
  // we already match those above via the basename. Driver picks
  // additional heuristics here in v0+1 if false-positive avoidance
  // becomes a friction (e.g., "config.yaml" inside an unrelated
  // workspace tree should NOT trigger spec validation).
  return null;
}

function SpecValidationPanel({ kind, yaml }: { kind: "rig" | "agent"; yaml: string }) {
  const review = useSpecReview(kind, yaml);
  if (review.isLoading) {
    return (
      <div data-testid="files-spec-validation-loading" className="mb-3 border border-outline-variant bg-background px-3 py-2 font-mono text-[10px] text-on-surface-variant">
        Validating {kind}.yaml…
      </div>
    );
  }
  if (review.isError) {
    return (
      <div data-testid="files-spec-validation-error" className="mb-3 border border-red-400 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
        Validation failed to run: {(review.error as Error)?.message ?? "unknown error"}
      </div>
    );
  }
  if (!review.data) return null;
  const errors = review.data.errors ?? [];
  const isValid = errors.length === 0;
  return (
    <div
      data-testid="files-spec-validation-panel"
      data-spec-kind={kind}
      data-valid={isValid}
      className={`mb-3 border px-3 py-2 font-mono text-[10px] ${
        isValid
          ? "border-emerald-400 bg-emerald-50 text-emerald-900"
          : "border-red-400 bg-red-50 text-red-900"
      }`}
    >
      <div className="mb-1 font-bold uppercase tracking-[0.10em]">
        {isValid ? `✓ Valid ${kind === "rig" ? "RigSpec" : "AgentSpec"}` : `✗ ${kind === "rig" ? "RigSpec" : "AgentSpec"} validation errors`}
      </div>
      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err, idx) => (
            <li
              key={idx}
              data-testid={`files-spec-validation-error-${idx}`}
              className="text-[10px]"
            >
              {err.field && <span className="font-bold">{err.field}: </span>}
              {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}
