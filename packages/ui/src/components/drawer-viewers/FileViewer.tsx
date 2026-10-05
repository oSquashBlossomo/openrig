// V1 attempt-3 Phase 4 — FileViewer per content-drawer.md L88–L108.
//
// Renders markdown / text / YAML / JSON / image / binary file refs.
//
// Source-aware drawer reader. Each opened reference is attributed to its
// origin instance: an explicit caller `originInstance`, otherwise the known
// host selection captured when this target opened (null = unknown). Local
// reads, images, downloads and sibling links require a local origin AND a
// current known-local selection, so a retained drawer never loads local bytes
// for a remote/unknown reference. Relative references resolve against the
// served canonical source (resolvedPath). Following a sibling or heading link
// stays in the drawer with its own Back stack.

import { useContext, useMemo, useState, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer, type MarkdownSource } from "../markdown/MarkdownViewer.js";
import {
  fileAssetUrl,
  FilesReadError,
  useFilesRead,
  useFilesRoots,
  type AllowlistRoot,
  type FilesReadResponse,
} from "../../hooks/useFiles.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { toolBrand } from "../../lib/tool-brand.js";
import {
  filesHref,
  fileOriginAdmission,
  filesLocationForTarget,
  sourceFactsFromRead,
  type FileOriginAdmission,
  type FileProjectIdentity,
  type FileSourceTarget,
} from "../files/file-source.js";
import { useFileOriginAdmission, useKnownSelectedHost } from "../files/useFileAdmission.js";
import { FileReadFacts } from "../files/FileReadFacts.js";

export type FileKind = "markdown" | "text" | "yaml" | "json" | "image" | "binary";

export interface FileViewerData {
  /** Display path shown in the drawer. Also used as the relative read path when `root` is set. */
  path: string;
  kind?: FileKind;
  /** Caller-supplied inline excerpt. Shown labelled; never a current read. */
  content?: string;
  imageUrl?: string;
  /** Existing /api/files allowlist root name. */
  root?: string;
  /** Optional explicit path under `root`; falls back to `path` when omitted. */
  readPath?: string;
  /** Absolute file path; resolved against /api/files/roots before reading. */
  absolutePath?: string | null;
  /** Exact host that produced this reference (null = unknown). When omitted,
   *  the known selection at open time is captured. */
  originInstance?: string | null;
  /** Heading to reveal (TUI slug). */
  anchor?: string;
  /** Applicable catalog project identity carried by the caller. */
  project?: FileProjectIdentity;
  /** Label for an inline excerpt (e.g. "Proof packet excerpt"). */
  excerptLabel?: string;
}

interface ResolvedReadTarget {
  root: string;
  path: string;
}

function inferKind(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".svg")) return "image";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "text";
  return "text";
}

function normalizeAbsolutePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function resolveFromAbsolutePath(
  roots: AllowlistRoot[] | undefined,
  absolutePath: string | null | undefined,
): ResolvedReadTarget | null {
  if (!roots || !absolutePath) return null;
  const normalizedFile = normalizeAbsolutePath(absolutePath);
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const root of sortedRoots) {
    const normalizedRoot = normalizeAbsolutePath(root.path);
    if (normalizedFile === normalizedRoot) return null;
    const prefix = `${normalizedRoot}/`;
    if (!normalizedFile.startsWith(prefix)) continue;
    const relativePath = normalizedFile.slice(prefix.length);
    if (!relativePath || relativePath.includes("../")) return null;
    return { root: root.name, path: relativePath };
  }
  return null;
}

function isSameOriginUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** Markdown source for content-only/blocked bodies: the producing origin and
 * its CURRENT admission. With no root, relative references stay unresolved. */
function inlineSource(origin: string | null, root: string, path: string, admission: FileOriginAdmission): MarkdownSource {
  return {
    facts: { target: { originInstance: origin, root, path }, canonicalPath: path, absolutePath: null },
    admitted: admission.admitted,
    ...(admission.admitted ? {} : { blockedMessage: admission.message }),
  };
}

function ViewerHeader({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <header className="px-4 py-3 border-b border-outline-variant">
      <div className="inline-flex items-center gap-1.5">
        <ToolMark tool={path} size="sm" decorative />
        <SectionHeader tone="muted">{toolBrand(path).label}</SectionHeader>
      </div>
      <h3 className="mt-1 font-mono text-xs text-on-surface break-all">{path}</h3>
      {children}
    </header>
  );
}

function Notice({ testId, tone = "neutral", children }: { testId: string; tone?: "neutral" | "warn" | "error"; children: ReactNode }) {
  const tones = {
    neutral: "border-outline-variant bg-background text-on-surface",
    warn: "border-amber-400 bg-amber-50 text-amber-900",
    error: "border-red-300 bg-red-50 text-red-900",
  } as const;
  return (
    <div data-testid={testId} role="status" className={`mx-4 mt-3 border px-3 py-2 font-mono text-[10px] leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

/** Content-only drawer body (no read target). Inline-only callers may render
 * without a QueryClient: then the selection is unknown and local URLs stay
 * withheld (never a default-local assumption). With a client, admission is
 * the reactive known-host boundary, so a mounted body withdraws local images
 * and links as soon as the selection changes. */
function InlineFileBody({ data }: { data: FileViewerData }) {
  const client = useContext(QueryClientContext);
  return client
    ? <InlineFileBodyWithHosts data={data} />
    : <InlineFileBodyView data={data} origin={data.originInstance ?? null} admission={fileOriginAdmission(data.originInstance ?? null, undefined)} />;
}

/** Identity of an opened inline item. Content/labels are data, not identity:
 * a refreshed excerpt of the same item must not be re-attributed. */
function inlineIdentity(data: FileViewerData): string {
  return [data.root ?? "", data.readPath ?? data.path, data.absolutePath ?? "", data.anchor ?? "", data.imageUrl ?? ""].join("\u0000");
}

function InlineFileBodyWithHosts({ data }: { data: FileViewerData }) {
  const known = useKnownSelectedHost();
  // Same open-time attribution as rooted reads when the caller gave none,
  // re-captured whenever a reused viewer receives a different item (the
  // shared drawer reuses FileViewer without a key).
  // An explicit producing origin (including null = unknown) is the item's
  // attribution: it seeds the capture, and a later explicit value for the same
  // item replaces it. Only an omitted origin falls back to the selection known
  // when the item opens; a later selection never re-attributes the item.
  const identity = inlineIdentity(data);
  const explicit = data.originInstance;
  const seed = explicit !== undefined ? explicit : known ?? null;
  const [captured, setCaptured] = useState<{ identity: string; origin: string | null }>(() => ({ identity, origin: seed }));
  const current = captured.identity !== identity
    ? { identity, origin: seed }
    : explicit !== undefined && explicit !== captured.origin ? { identity, origin: explicit } : captured;
  if (current !== captured) setCaptured(current);
  // This render already uses the new item's capture; the stale origin is
  // never applied to a different item, even transiently.
  const origin = data.originInstance !== undefined ? data.originInstance : current.origin;
  const admission = useFileOriginAdmission(origin);
  return <InlineFileBodyView data={data} origin={origin} admission={admission} />;
}

function InlineFileBodyView({ data, origin, admission }: { data: FileViewerData; origin: string | null; admission: FileOriginAdmission }) {
  const resolvedKind = data.kind ?? inferKind(data.path);
  const image = data.imageUrl && (!isSameOriginUrl(data.imageUrl) || admission.admitted) ? data.imageUrl : undefined;
  const markdown = data.content !== undefined && resolvedKind === "markdown"
    ? <MarkdownViewer content={data.content} source={inlineSource(origin, data.root ?? "", data.readPath ?? data.path, admission)} />
    : undefined;
  return (
    <div data-testid="file-viewer" data-file-kind={resolvedKind} data-read-state="inline" className="flex flex-col h-full">
      <ViewerHeader path={data.path} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {data.content !== undefined && (
          <Notice testId="file-viewer-inline-excerpt">
            {data.excerptLabel ?? "Inline excerpt"} supplied by this page — not a current read of the file.
          </Notice>
        )}
        {data.imageUrl && !image && (
          <Notice testId="file-viewer-asset-withheld" tone="warn">Image withheld: it is a local URL and this reference is not attributed to the connected local instance.</Notice>
        )}
        <KindBody kind={resolvedKind} path={data.path} content={data.content} imageUrl={image} markdown={markdown} />
      </div>
    </div>
  );
}

function KindBody({ kind, path, content, imageUrl, markdown }: {
  kind: FileKind; path: string; content?: string; imageUrl?: string; markdown?: ReactNode;
}) {
  return (
    <>
      {kind === "markdown" && content !== undefined ? (
        <div className="px-4 py-3">{markdown ?? <MarkdownViewer content={content} />}</div>
      ) : null}
      {(kind === "yaml" || kind === "json") && content !== undefined ? (
        <pre className="px-4 py-3 font-mono text-xs text-on-surface whitespace-pre-wrap">{content}</pre>
      ) : null}
      {kind === "text" && content !== undefined ? (
        <pre className="px-4 py-3 font-mono text-xs text-on-surface whitespace-pre overflow-x-auto">{content}</pre>
      ) : null}
      {kind === "image" && imageUrl ? (
        <div className="px-4 py-3 flex justify-center">
          <img src={imageUrl} alt={path} className="max-w-full h-auto" />
        </div>
      ) : null}
      {kind === "binary" ? (
        <div className="px-4 py-6">
          <EmptyState label="BINARY" description="Cannot preview; download instead." variant="card" testId="file-viewer-binary" />
        </div>
      ) : null}
    </>
  );
}

interface CapturedState {
  identity: string;
  origin: string | null;
  /** Targets opened from inside this drawer (sibling/anchor links). */
  stack: FileSourceTarget[];
}

function FileViewerWithFetch({ data }: { data: FileViewerData }) {
  const known = useKnownSelectedHost();
  const identity = `${data.root ?? ""}\u0000${data.readPath ?? data.path}\u0000${data.absolutePath ?? ""}\u0000${data.anchor ?? ""}`;
  const [captured, setCaptured] = useState<CapturedState>(() => ({
    identity,
    origin: data.originInstance !== undefined ? data.originInstance : known ?? null,
    stack: [],
  }));
  // A new selection in the same drawer re-attributes at its own open time.
  if (captured.identity !== identity) {
    setCaptured({ identity, origin: data.originInstance !== undefined ? data.originInstance : known ?? null, stack: [] });
  }
  const origin = data.originInstance !== undefined ? data.originInstance : captured.origin;
  const admission = useFileOriginAdmission(origin);

  // Absolute-path callers resolve against roots only under admission.
  const explicit = data.root ? { root: data.root, path: data.readPath ?? data.path } : null;
  const needsRoots = !explicit && !!data.absolutePath;
  const roots = useFilesRoots({ enabled: admission.admitted && needsRoots });
  const absoluteTarget = useMemo(() => {
    if (!needsRoots) return null;
    const rootData = roots.data;
    if (!rootData || "unavailable" in rootData) return null;
    return resolveFromAbsolutePath(rootData.roots, data.absolutePath);
  }, [data.absolutePath, needsRoots, roots.data]);
  const base = explicit ?? absoluteTarget;
  const top = captured.stack[captured.stack.length - 1];
  const current: FileSourceTarget | null = top ?? (base ? {
    originInstance: origin,
    root: base.root,
    path: base.path,
    ...(data.anchor ? { anchor: data.anchor } : {}),
    ...(data.project ? { project: data.project } : {}),
  } : null);

  const push = (target: FileSourceTarget) => setCaptured((c) => ({ ...c, stack: [...c.stack, target] }));
  const back = () => setCaptured((c) => ({ ...c, stack: c.stack.slice(0, -1) }));
  const attributeToCurrent = known === LOCAL_HOST_ID && origin === null && data.originInstance === undefined
    ? () => setCaptured((c) => ({ ...c, origin: known }))
    : undefined;

  if (!admission.admitted) {
    return (
      <BlockedViewer path={data.path} origin={origin} sourceRoot={data.root ?? ""} sourcePath={data.readPath ?? data.path} admission={admission} content={data.content} kind={data.kind ?? inferKind(data.path)}
        excerptLabel={data.excerptLabel} onAttribute={attributeToCurrent} />
    );
  }
  if (needsRoots && roots.isLoading) {
    return <EmptyState label="LOADING" description={`Loading ${data.path}...`} variant="card" testId="file-viewer-empty" />;
  }
  if (!current) {
    if (data.content !== undefined) return <InlineFileBody data={{ ...data, originInstance: origin }} />;
    return (
      <EmptyState
        label="FILE UNAVAILABLE"
        description={roots.isError ? `Could not read the configured file roots: ${(roots.error as Error)?.message ?? "error"}` : `No configured file root contains ${data.path}.`}
        variant="card"
        testId="file-viewer-error"
      />
    );
  }
  return (
    <AdmittedReader
      key={`${current.root}\u0000${current.path}`}
      displayPath={top ? current.path : data.path}
      target={current}
      kind={top ? inferKind(current.path) : data.kind ?? inferKind(data.path)}
      inline={top ? undefined : data}
      depth={captured.stack.length}
      onOpen={push}
      onBack={captured.stack.length > 0 ? back : undefined}
      onAnchor={(anchor) => push({ ...current, anchor })}
    />
  );
}

function BlockedViewer({ path, origin, sourceRoot, sourcePath, admission, content, kind, excerptLabel, onAttribute }: {
  path: string; origin: string | null; sourceRoot: string; sourcePath: string; admission: Extract<FileOriginAdmission, { admitted: false }>; content?: string; kind: FileKind;
  excerptLabel?: string; onAttribute?: () => void;
}) {
  return (
    <div data-testid="file-viewer" data-file-kind={kind} data-read-state="blocked" data-block-reason={admission.reason} className="flex flex-col h-full">
      <ViewerHeader path={path} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Notice testId="file-viewer-blocked" tone="warn">
          {admission.message}
          {onAttribute && (
            <button type="button" data-testid="file-viewer-attribute-local" onClick={onAttribute}
              className="ml-2 border border-amber-500 bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em]">
              read from connected local instance
            </button>
          )}
        </Notice>
        {content !== undefined && (
          <>
            <Notice testId="file-viewer-inline-excerpt">{excerptLabel ?? "Inline excerpt"} supplied by this page — not a current read of the file. Local images and links in it are withheld.</Notice>
            {kind === "markdown"
              ? <div className="px-4 py-3"><MarkdownViewer content={content} source={inlineSource(origin, sourceRoot, sourcePath, admission)} /></div>
              : <pre className="px-4 py-3 font-mono text-xs text-on-surface whitespace-pre-wrap">{content}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function readFailure(error: unknown): { reason: "absent" | "bad_path" | "read_error"; text: string } {
  if (error instanceof FilesReadError) {
    if (error.code === "absent") return { reason: "absent", text: "Deleted or missing: the file was not found on disk." };
    if (error.code === "bad_path") return { reason: "bad_path", text: "The path is outside the configured root or invalid." };
  }
  return { reason: "read_error", text: (error as Error)?.message ?? "The read failed." };
}

function AdmittedReader({ displayPath, target, kind, inline, depth, onOpen, onBack, onAnchor }: {
  displayPath: string;
  target: FileSourceTarget;
  kind: FileKind;
  inline?: FileViewerData;
  depth: number;
  onOpen: (target: FileSourceTarget) => void;
  onBack?: () => void;
  onAnchor: (anchor: string) => void;
}) {
  const read = useFilesRead(target.root, target.path);
  const data = read.data;
  const router = useRouter({ warn: false });
  const location = filesLocationForTarget(target);
  const header = (
    <ViewerHeader path={displayPath}>
      <div data-testid="file-viewer-root-path" className="mt-1 font-mono text-[9px] text-on-surface-variant break-all">
        {target.root}/{target.path}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[0.10em]">
        {onBack && (
          <button type="button" data-testid="file-viewer-back" onClick={onBack}
            className="border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-low">
            ← back{depth > 1 ? ` (${depth})` : ""}
          </button>
        )}
        {location && (
          <a data-testid="file-viewer-open-files" href={filesHref(location)}
            onClick={(e) => {
              if (!router || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              router.history.push(filesHref(location));
            }}
            className="border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-low">
            open in files
          </a>
        )}
        {data && (
          <a data-testid="file-viewer-download" href={fileAssetUrl(target.root, target.path)} download
            className="border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-low">
            download
          </a>
        )}
      </div>
    </ViewerHeader>
  );

  // Inline caller excerpt is labelled; it never replaces a current read.
  if (inline?.content !== undefined) {
    return (
      <div data-testid="file-viewer" data-file-kind={kind} data-read-state="inline" className="flex flex-col h-full">
        {header}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Notice testId="file-viewer-inline-excerpt">{inline.excerptLabel ?? "Inline excerpt"} supplied by this page — not a current read of the file.</Notice>
          <KindBody kind={kind} path={displayPath} content={inline.content}
            markdown={<MarkdownViewer content={inline.content} source={{ facts: sourceFactsFromRead(target, data), admitted: true }} onOpenFile={onOpen} />} />
        </div>
      </div>
    );
  }

  if (read.isLoading || (!data && !read.isError)) {
    return <EmptyState label="LOADING" description={`Loading ${displayPath}...`} variant="card" testId="file-viewer-empty" />;
  }
  if (!data) {
    const failure = readFailure(read.error);
    return (
      <div data-testid="file-viewer" data-file-kind={kind} data-read-state={failure.reason} className="flex flex-col h-full">
        {header}
        <EmptyState label={failure.reason === "absent" ? "DELETED OR MISSING" : "FILE UNAVAILABLE"} description={failure.text} variant="card" testId="file-viewer-error" />
      </div>
    );
  }
  return (
    <div data-testid="file-viewer" data-file-kind={kind} data-read-state={read.isError ? "refresh-failed" : "current"} className="flex flex-col h-full">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <FileReadFacts read={data} target={target} testIdPrefix="file-viewer" />
        {read.isError && (
          <Notice testId="file-viewer-refresh-failed" tone="error">
            Refresh failed ({readFailure(read.error).text}). Showing the last successful read from {new Date(read.dataUpdatedAt).toISOString()}.
          </Notice>
        )}
        <ReadBody read={data} kind={kind} target={target} displayPath={displayPath} onOpen={onOpen} onAnchor={onAnchor} />
      </div>
    </div>
  );
}

function ReadBody({ read, kind, target, displayPath, onOpen, onAnchor }: {
  read: FilesReadResponse; kind: FileKind; target: FileSourceTarget; displayPath: string;
  onOpen: (target: FileSourceTarget) => void; onAnchor: (anchor: string) => void;
}) {
  if (kind === "image") {
    return <KindBody kind="image" path={displayPath} imageUrl={fileAssetUrl(target.root, target.path)} />;
  }
  if (read.binary) {
    return (
      <Notice testId="file-viewer-binary-read" tone="warn">
        Binary or non-UTF-8 file; text is not displayed. Use download to inspect its bytes.
      </Notice>
    );
  }
  if (read.content === "") {
    return <Notice testId="file-viewer-empty-file">Empty file — the read completed with 0 bytes.</Notice>;
  }
  return (
    <>
      {read.truncated && (
        <Notice testId="file-viewer-truncated" tone="warn">
          Truncated preview: showing the first {read.truncatedAtBytes ?? "?"} of {read.totalBytes ?? read.size} bytes. The rest of the file is not shown.
        </Notice>
      )}
      <KindBody
        kind={kind}
        path={displayPath}
        content={read.content}
        markdown={
          <MarkdownViewer
            content={read.content}
            source={{ facts: sourceFactsFromRead(target, read), admitted: true, truncated: read.truncated === true }}
            anchor={target.anchor}
            onOpenFile={onOpen}
            onAnchorChange={(anchor) => { if (anchor !== target.anchor) onAnchor(anchor); }}
          />
        }
      />
    </>
  );
}

export function FileViewer(data: FileViewerData) {
  if (!data.root && !data.absolutePath) {
    // OPR.0.4.4.20 retro-demo fixback: a caller that provides neither inline
    // content NOR any readable target (root/readPath or absolutePath) can
    // never load anything — say so honestly instead of the misleading
    // eternal "Loading ..." the demo proof caught (backend reads were fine;
    // the viewer was never given a target to ask for).
    if (data.content === undefined && !data.imageUrl) {
      return (
        <EmptyState
          label="NOT RESOLVABLE"
          description={`No readable target for ${data.path}: the caller provided neither content nor a file root/absolute path.`}
          variant="card"
          testId="file-viewer-unresolvable"
        />
      );
    }
    return <InlineFileBody data={data} />;
  }
  return <FileViewerWithFetch data={data} />;
}
