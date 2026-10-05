// UI Enhancement Pack v0 — lightweight markdown viewer (no deps).
//
// Per the audit: no markdown libraries are installed in the UI
// package. This component implements a small parser that handles the
// cases operators hit when reading canon docs:
//   - YAML frontmatter (rendered as a metadata header above the body)
//   - Headings (# / ## / ### / ####)
//   - Lists (- / * / nested by 2-space indent)
//   - Numbered lists (1. / 2. / ...)
//   - Code blocks (``` with language tag → SyntaxHighlight component)
//   - Inline code (`...`)
//   - Bold (**...**) / italic (*...*) — light support
//   - Links ([text](url)) and images (![alt](url))
//   - Tables (| col | col |)
//   - Mermaid code blocks → "[render mermaid]" placeholder per PRD
//     item 2 carve-out (no mermaid lib bundled at v0 — named v0+1
//     trigger applies if dogfood reports the click-to-render flow is
//     friction)
//
// Image src resolution: absolute URLs and `data:` URIs pass through;
// relative paths are resolved against the optional `assetBasePath`
// prop so the daemon's /api/files/asset endpoint or the slice's
// /api/slices/<name>/proof-asset/ endpoint can serve them.
//
// Source-aware reading (`source` prop): headings carry TUI-compatible
// slugs (duplicates suffixed, fenced pseudo-headings excluded), same-document
// links scroll inside this viewer, relative links/images resolve against the
// served canonical source path, and local effects require origin admission.
// External http(s) links stay explicit new-tab links; other schemes are inert.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  createSlugger,
  filesHref,
  filesLocationForTarget,
  markdownDestination,
  resolveFileAsset,
  resolveFileReference,
  type FileSourceFacts,
  type FileSourceTarget,
} from "../files/file-source.js";
import { SyntaxHighlight } from "./SyntaxHighlight.js";
import { extractKind, isFencedBlockLanguage } from "./storytelling-primitives.js";
import { FencedBlockRenderer } from "./blocks.js";
import { KindFrame } from "./kind-frame.js";

export interface MarkdownViewerProps {
  content: string;
  /** Used to resolve relative image src + link href. Optional. */
  assetBasePath?: string;
  /** Hide the YAML frontmatter metadata header (default false). */
  hideFrontmatter?: boolean;
  /** Operator Surface Reconciliation v0 item 4: hide the raw/rendered
   *  toggle for callers (e.g., the steering Priority Stack panel) where
   *  the toggle would visually compete with the surrounding shell. */
  hideRawToggle?: boolean;
  /** Exact served source of this document. Enables source-relative links
   *  and images; without it legacy assetBasePath behavior is unchanged. */
  source?: MarkdownSource;
  /** Heading slug to reveal (from a target's anchor). */
  anchor?: string;
  /** Called after an in-document heading link is followed. */
  onAnchorChange?: (anchor: string) => void;
  /** Opens a resolved sibling target (Files workspace / drawer stack). */
  onOpenFile?: (target: FileSourceTarget) => void;
}

export interface MarkdownSource {
  facts: FileSourceFacts;
  /** Local origin admission; false withholds every local URL/effect. */
  admitted: boolean;
  blockedMessage?: string;
  /** The text is a truncated prefix (anchor misses say so). */
  truncated?: boolean;
}

interface RenderContext {
  assetBasePath?: string;
  source?: MarkdownSource;
  onOpenFile?: (target: FileSourceTarget) => void;
  onAnchor: (anchor: string) => void;
}

export function MarkdownViewer({ content, assetBasePath, hideFrontmatter = false, hideRawToggle = false, source, anchor, onAnchorChange, onOpenFile }: MarkdownViewerProps) {
  const parsed = useMemo(() => parseMarkdown(content), [content]);
  const articleRef = useRef<HTMLElement>(null);
  const reveal = useCallback((slug: string) => {
    const heading = findHeading(articleRef.current, slug);
    if (!heading) return false;
    heading.scrollIntoView?.({ block: "start" });
    heading.focus({ preventScroll: true });
    return true;
  }, []);
  const onAnchor = useCallback((slug: string) => {
    reveal(slug);
    onAnchorChange?.(slug);
  }, [reveal, onAnchorChange]);
  const anchorFound = !anchor || parsed.anchors.has(anchor);
  // Reveal the requested heading when the target or document changes.
  useEffect(() => {
    if (anchor) reveal(anchor);
  }, [anchor, parsed, reveal]);
  const ctx: RenderContext = { assetBasePath, source, onOpenFile, onAnchor };
  // Operator Surface Reconciliation v0 item 4: per-instance toggle
  // between rendered (default) and raw (monospace pre-rendered text +
  // visible Markdown source). Frontmatter metadata header still
  // renders in raw mode unless hideFrontmatter is set.
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  return (
    <article ref={articleRef} data-testid="markdown-viewer" data-mode={mode} className="prose-tactical max-w-none">
      {!anchorFound && (
        <div data-testid="md-anchor-missing" role="status" className="mb-2 border border-outline-variant bg-background px-3 py-1.5 font-mono text-[10px] text-on-surface-variant">
          Heading not found: #{anchor}{source?.truncated ? " in the returned prefix" : ""}; showing from the start.
        </div>
      )}
      {!hideRawToggle && (
        <div data-testid="markdown-viewer-mode-toggle" className="mb-2 flex items-center gap-1">
          <button
            type="button"
            data-testid="markdown-viewer-mode-rendered"
            data-active={mode === "rendered"}
            onClick={() => setMode("rendered")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "rendered"
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            rendered
          </button>
          <button
            type="button"
            data-testid="markdown-viewer-mode-raw"
            data-active={mode === "raw"}
            onClick={() => setMode("raw")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "raw"
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            raw
          </button>
        </div>
      )}
      {!hideFrontmatter && parsed.frontmatter && (
        <FrontmatterHeader frontmatter={parsed.frontmatter} />
      )}
      {mode === "raw" ? (
        <pre data-testid="markdown-viewer-raw" className="overflow-x-auto whitespace-pre-wrap break-words bg-background p-3 font-mono text-[10px] text-on-surface">
          {content}
        </pre>
      ) : (
        <RenderedBody parsed={parsed} ctx={ctx} />
      )}
    </article>
  );
}

/** 0.3.1 slice 06 — kind-aware rendered body. When the frontmatter
 *  declares a known `kind:`, the body is wrapped in a KindFrame so
 *  the viewer presents a header chrome + optional TL;DR slate + the
 *  rest of the body. Unknown kind or missing frontmatter falls
 *  through to the plain block flow — the same rendering that's been
 *  in place since UI Enhancement Pack v0. Fenced-block grammars
 *  (timeline / stats / risk-table / compare / slate) are intercepted
 *  inside BlockRenderer regardless of whether a kind is set so the
 *  primitives are usable from any markdown surface. */
function RenderedBody({ parsed, ctx }: { parsed: ParsedDocument; ctx: RenderContext }) {
  const kind = extractKind(parsed.frontmatter);
  const body = (
    <div className="space-y-3" data-testid="markdown-viewer-rendered">
      {parsed.blocks.map((block, idx) => (
        <BlockRenderer key={idx} block={block} ctx={ctx} />
      ))}
    </div>
  );
  if (kind && parsed.frontmatter) {
    return <KindFrame kind={kind} frontmatter={parsed.frontmatter}>{body}</KindFrame>;
  }
  return body;
}

interface ParsedDocument {
  frontmatter: Record<string, string> | null;
  blocks: Block[];
  anchors: Set<string>;
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

type Block =
  | { type: "heading"; level: HeadingLevel; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string | null; text: string; isMermaid: boolean }
  | { type: "list"; ordered: boolean; items: Array<{ depth: number; text: string; ordinal: number | null }> }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "blank" };

// One grammar owns list-item recognition and capture. Requiring authored text
// keeps a bare marker out of the list branch, so it advances once through the
// ordinary paragraph path and remains visible instead of looping or vanishing.
const LIST_ITEM_LINE = /^(\s*)(?:([-*])|(\d+)\.)\s+(.+)$/;

// Heading grammar shared with TUI reading.ts: up to 3 leading spaces, levels
// 1-6, optional closing #s. Fences (``` or ~~~) hide pseudo-headings.
const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE_OPEN = /^\s{0,3}(```|~~~)\s*([\w-]*)[^\n]*$/;

function parseMarkdown(content: string): ParsedDocument {
  const { frontmatter, body } = stripFrontmatter(content);
  const lines = body.split(/\r\n|\r|\n/);
  const blocks: Block[] = [];
  const slug = createSlugger();
  const anchors = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block. Language matcher accepts hyphens so 0.3.1
    // slice 06 fenced-block grammars like `risk-table` parse cleanly.
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] || null;
      const isMermaid = language?.toLowerCase() === "mermaid";
      const start = i + 1;
      let end = start;
      while (end < lines.length && !(lines[end]!.trim().startsWith(marker) && lines[end]!.trim().slice(marker.length).trim() === "")) end++;
      const text = lines.slice(start, end).join("\n");
      blocks.push({ type: "code", language, text, isMermaid });
      i = end + 1;
      continue;
    }

    // Heading.
    const heading = line.match(HEADING_LINE);
    if (heading) {
      const id = slug(heading[2]!);
      anchors.add(id);
      blocks.push({ type: "heading", level: heading[1]!.length as HeadingLevel, text: heading[2]!, id });
      i++;
      continue;
    }

    // List (bulleted or ordered).
    const firstListItem = line.match(LIST_ITEM_LINE);
    if (firstListItem) {
      const items: Array<{ depth: number; text: string; ordinal: number | null }> = [];
      const ordered = firstListItem[3] !== undefined;
      while (i < lines.length) {
        const m = lines[i]!.match(LIST_ITEM_LINE);
        if (!m) break;
        const indent = m[1]!.length;
        const parts = [m[4]!.trim()];
        const ordinal = m[3] === undefined ? null : Number(m[3]);
        i++;
        // A nonblank, non-item line belongs to this item only when it is
        // strictly deeper than the authored marker. Joined display text uses
        // one space, retaining containment without inventing another item.
        while (i < lines.length) {
          const continuation = lines[i]!;
          if (continuation.trim() === "" || LIST_ITEM_LINE.test(continuation)) break;
          const continuationIndent = continuation.length - continuation.trimStart().length;
          if (continuationIndent <= indent) break;
          parts.push(continuation.trim());
          i++;
        }
        items.push({
          depth: Math.floor(indent / 2),
          text: parts.join(" "),
          ordinal,
        });
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Table (header + separator + body rows).
    if (line.match(/^\s*\|.*\|\s*$/) && i + 1 < lines.length && lines[i + 1]!.match(/^\s*\|[\s\-:|]+\|\s*$/)) {
      const headers = parseTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.match(/^\s*\|.*\|\s*$/)) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-blank, non-special lines).
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") break;
      if (FENCE_OPEN.test(next) || HEADING_LINE.test(next) || LIST_ITEM_LINE.test(next) || next.match(/^\s*\|.*\|\s*$/)) break;
      paragraph.push(next);
      i++;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return { frontmatter, blocks, anchors };
}

function findHeading(article: HTMLElement | null, slug: string): HTMLElement | null {
  if (!article) return null;
  for (const el of article.querySelectorAll<HTMLElement>("[data-md-anchor]")) {
    if (el.getAttribute("data-md-anchor") === slug) return el;
  }
  return null;
}

function stripFrontmatter(content: string): { frontmatter: Record<string, string> | null; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endMatch = rest.match(/(^|\n)---(\n|$)/);
  if (!endMatch || endMatch.index === undefined) return { frontmatter: null, body: content };
  const fmText = rest.slice(0, endMatch.index);
  const body = rest.slice(endMatch.index + endMatch[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([\w.-]+):\s*(.+?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      frontmatter[m[1]!] = v;
    }
  }
  return { frontmatter, body };
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function FrontmatterHeader({ frontmatter }: { frontmatter: Record<string, string> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section
      data-testid="markdown-frontmatter"
      className="mb-4 border border-outline-variant bg-background p-3"
    >
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">
        Frontmatter
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="font-mono text-[10px] font-bold text-on-surface">{k}</dt>
            <dd className="font-mono text-[10px] text-on-surface break-all">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function BlockRenderer({ block, ctx }: { block: Block; ctx: RenderContext }) {
  if (block.type === "blank") return null;
  if (block.type === "heading") {
    const sizes = { 1: "text-lg font-bold", 2: "text-base font-bold", 3: "text-sm font-bold", 4: "text-xs font-bold", 5: "text-xs font-bold", 6: "text-xs font-semibold" } as const;
    const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
    return (
      <Tag
        id={block.id || undefined}
        data-md-anchor={block.id}
        tabIndex={-1}
        data-testid={`md-heading-${block.level}`}
        className={`${sizes[block.level]} mt-4 scroll-mt-4 text-on-surface outline-none focus-visible:ring-1 focus-visible:ring-on-surface`}
      >
        {renderInline(block.text, ctx)}
      </Tag>
    );
  }
  if (block.type === "paragraph") {
    return <p data-testid="md-paragraph" className="text-[12px] leading-relaxed text-on-surface">{renderInline(block.text, ctx)}</p>;
  }
  if (block.type === "code") {
    // 0.3.1 slice 06 — intercept fenced-block grammars before the
    // generic SyntaxHighlight fallback. Unknown languages fall
    // through to SyntaxHighlight, preserving the original behavior.
    if (isFencedBlockLanguage(block.language)) {
      return <FencedBlockRenderer language={block.language} text={block.text} />;
    }
    if (block.isMermaid) {
      return (
        <div data-testid="md-mermaid-placeholder" className="border border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
            mermaid diagram (v0+1 trigger: render-on-click flow)
          </div>
          <pre className="overflow-x-auto bg-stone-900 p-2 font-mono text-[10px] text-stone-100">
            <code>{block.text}</code>
          </pre>
          <button
            type="button"
            data-testid="md-mermaid-render-btn"
            disabled
            title="Mermaid rendering not bundled at v0 (named v0+1 trigger). Inspect the source above."
            className="mt-2 cursor-not-allowed border border-amber-400 bg-amber-100 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.10em] text-amber-800"
          >
            [render mermaid] (v0+1)
          </button>
        </div>
      );
    }
    return <SyntaxHighlight code={block.text} language={block.language} />;
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag data-testid={`md-list-${block.ordered ? "ol" : "ul"}`} className={`${block.ordered ? "list-decimal" : "list-disc"} ml-5 space-y-1 text-[12px] text-on-surface`}>
        {block.items.map((item, idx) => (
          <li
            key={idx}
            value={block.ordered && item.ordinal !== null ? item.ordinal : undefined}
            style={{ marginLeft: `${item.depth * 1}rem` }}
          >
            {renderInline(item.text, ctx)}
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.type === "table") {
    return (
      <div data-testid="md-table-wrapper" className="overflow-x-auto">
        <table className="w-full border-collapse border border-outline-variant text-[10px]">
          <thead className="bg-surface-low">
            <tr>{block.headers.map((h, i) => <th key={i} className="border border-outline-variant px-2 py-1 text-left font-bold text-on-surface">{renderInline(h, ctx)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "bg-surface-lowest" : "bg-background"}>
                {row.map((cell, ci) => <td key={ci} className="border border-outline-variant px-2 py-1 text-on-surface">{renderInline(cell, ctx)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

// Light inline parser: handles `code`, **bold**, *italic*, [text](url), ![alt](url).
function renderInline(text: string, ctx: RenderContext): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const flushPlain = (start: number, end: number) => {
    if (end > start) nodes.push(text.slice(start, end));
  };
  let plainStart = 0;
  while (i < text.length) {
    const remaining = text.slice(i);
    // Image: ![alt](src)
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      flushPlain(plainStart, i);
      nodes.push(<InlineImage key={key++} alt={imgMatch[1] ?? ""} rawSrc={imgMatch[2]!} ctx={ctx} />);
      i += imgMatch[0].length;
      plainStart = i;
      continue;
    }
    // Link: [text](href)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      flushPlain(plainStart, i);
      nodes.push(<InlineLink key={key++} label={linkMatch[1]!} rawHref={linkMatch[2]!} ctx={ctx} />);
      i += linkMatch[0].length;
      plainStart = i;
      continue;
    }
    // Inline code: `...`
    if (remaining.startsWith("`")) {
      const close = remaining.indexOf("`", 1);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(
          <code
            key={key++}
            data-testid="md-inline-code"
            className="bg-surface-low px-1 font-mono text-[10px] text-on-surface"
          >
            {remaining.slice(1, close)}
          </code>,
        );
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    // Bold: **...**
    if (remaining.startsWith("**")) {
      const close = remaining.indexOf("**", 2);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(<strong key={key++} className="font-bold">{remaining.slice(2, close)}</strong>);
        i += close + 2;
        plainStart = i;
        continue;
      }
    }
    // Italic: *...*
    if (remaining.startsWith("*") && !remaining.startsWith("**")) {
      const close = remaining.indexOf("*", 1);
      if (close !== -1 && close > 1) {
        flushPlain(plainStart, i);
        nodes.push(<em key={key++} className="italic">{remaining.slice(1, close)}</em>);
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(plainStart, text.length);
  return nodes;
}

const LINK_CLASS = "text-blue-700 underline hover:text-blue-900";
const INERT_CLASS = "cursor-help text-on-surface underline decoration-dotted";

function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function InlineLink({ label, rawHref, ctx }: { label: string; rawHref: string; ctx: RenderContext }): ReactNode {
  const href = markdownDestination(rawHref);
  const external = (
    <>
      <a data-testid="md-inline-link" data-link-kind="external" href={href} target="_blank" rel="noopener noreferrer" title={`Opens ${href} in a new tab`} className={LINK_CLASS}>
        {label}
      </a>
      <span aria-hidden="true" className="ml-0.5 text-[9px] text-on-surface-variant">↗</span>
    </>
  );
  const inert = (reason: string, kind = "unsupported") => (
    <span data-testid="md-inline-link" data-link-kind={kind} title={reason} className={INERT_CLASS}>{label}</span>
  );
  const anchorLink = (slug: string) => (
    <a
      data-testid="md-inline-link"
      data-link-kind="anchor"
      href={`#${encodeURIComponent(slug)}`}
      onClick={(e) => { if (!plainClick(e)) return; e.preventDefault(); ctx.onAnchor(slug); }}
      className={LINK_CLASS}
    >
      {label}
    </a>
  );
  if (!ctx.source) {
    // Legacy (unattributed) documents: explicit external and same-document
    // links work; other relative hrefs keep their historical passthrough.
    if (/^https?:\/\//i.test(href)) return external;
    if (href.startsWith("#") && href.length > 1) {
      try { return anchorLink(decodeURIComponent(href.slice(1))); } catch { return inert("Invalid percent-encoding in reference; nothing opened."); }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return inert("Unsupported reference scheme; nothing opened.");
    return (
      <a data-testid="md-inline-link" href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>{label}</a>
    );
  }
  const ref = resolveFileReference(ctx.source.facts, href);
  if (ref.kind === "external") return external;
  if (ref.kind === "unsupported") return inert(ref.reason);
  if (ref.kind === "anchor") return anchorLink(ref.anchor);
  if (!ctx.source.admitted) return inert(ctx.source.blockedMessage ?? "Local file links are unavailable for this source.", "file-blocked");
  const location = filesLocationForTarget(ref.target);
  const target = ref.target;
  return (
    <a
      data-testid="md-inline-link"
      data-link-kind="file"
      data-target-root={target.root}
      data-target-path={target.path}
      href={location ? filesHref(location) : undefined}
      title={`${target.root}/${target.path}${target.anchor ? `#${target.anchor}` : ""}`}
      onClick={(e) => {
        if (!ctx.onOpenFile || !plainClick(e)) return;
        e.preventDefault();
        ctx.onOpenFile(target);
      }}
      className={LINK_CLASS}
    >
      {label}
    </a>
  );
}

function InlineImage({ alt, rawSrc, ctx }: { alt: string; rawSrc: string; ctx: RenderContext }): ReactNode {
  const img = (src: string, kind: string) => (
    <img data-testid="md-inline-image" data-src-kind={kind} src={src} alt={alt} loading="lazy" className="my-2 inline-block max-w-full border border-outline-variant" />
  );
  const withheld = (reason: string) => (
    <span data-testid="md-image-withheld" role="img" aria-label={`${alt || "image"} (not loaded)`} title={reason}
      className="my-1 inline-block border border-dashed border-outline-variant px-2 py-1 font-mono text-[10px] text-on-surface-variant">
      [image{alt ? `: ${alt}` : ""} — {reason}]
    </span>
  );
  if (!ctx.source) return img(resolveAssetUrl(rawSrc, ctx.assetBasePath), "legacy");
  const asset = resolveFileAsset(ctx.source.facts, rawSrc);
  if (asset.kind === "external") return img(asset.url, "external");
  if (asset.kind === "unsupported") return withheld(asset.reason);
  if (!ctx.source.admitted) return withheld(ctx.source.blockedMessage ?? "local image withheld");
  return img(asset.url, asset.kind);
}

function resolveAssetUrl(src: string, assetBasePath?: string): string {
  if (!src) return src;
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("/")) return src;
  if (!assetBasePath) return src;
  // Treat assetBasePath as a URL prefix; combine carefully so we don't
  // double-slash or strip the path's relative segment.
  const sep = assetBasePath.endsWith("/") ? "" : "/";
  return `${assetBasePath}${sep}${src}`;
}

// Minimal Fragment-equivalent without importing react/jsx-runtime
// directly — react-19 supplies Fragment via the named export.
import { Fragment } from "react";
