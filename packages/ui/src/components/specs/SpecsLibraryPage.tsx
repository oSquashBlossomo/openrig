import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary, type ContextPackEntry } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary, type AgentImageEntry } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillHref } from "../../lib/library-skills-routing.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
// Phase 3a slice 3.3 — plugins library category.
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";
import {
  CATALOG_KINDS, CATALOG_ORIGINS, EMPTY_FILTER, candidateFacts, catalogSearch, isFiltered, matchesOrigin,
  matchesText, parseCatalogFilter, readAge, specCatalogKind, type CatalogFilter, type CatalogKind,
} from "./library-model.js";
import { LibraryEntryLink, originLabel, useHostSelectionState } from "./library-reads.js";

/** Every toolbar entry reaches the operation its label names. Spec authoring
 * that has no browser API is explicit guidance, never a misleading route. */
const TOOLBAR_ACTIONS = [
  { label: "Import rig", to: "/import", testId: "specs-toolbar-import", title: "Validate, preflight and instantiate a rig from YAML" },
  { label: "Validate agent spec", to: "/agents/validate", testId: "specs-toolbar-validate-agent", title: "Check an agent spec before adding it" },
  { label: "Discover", to: "/discovery/inventory", testId: "specs-toolbar-discover", title: "Find unmanaged sessions and draft a rig spec from them" },
] as const;

/** Minimal shape of a TanStack query result consumed by the read-state line. */
interface ReadQuery {
  isLoading: boolean;
  error: unknown;
  dataUpdatedAt: number;
  data?: unknown;
  refetch: () => unknown;
}

type SectionState = "loading" | "ok" | "stale" | "failed";
function sectionState(query: ReadQuery): SectionState {
  if (query.data !== undefined) return query.error ? "stale" : "ok";
  if (query.error) return "failed";
  return "loading";
}

interface LibraryRow {
  id: string;
  label: string;
  meta?: string;
  /** Distinguishing facts shown only when another row has the same label. */
  facts?: string;
  entryId?: string;
  /** Slice 11 — diagnostic state for unparseable YAML in the workflows
   *  folder. "error" rows render non-navigable with the parser/validator
   *  message inline so the operator can fix the file in place. */
  status?: "valid" | "error";
}

function specRow(entry: SpecLibraryEntry): LibraryRow {
  if (entry.status === "error") {
    // Diagnostic row: no entryId → non-navigable; meta carries the
    // parse/validate reason so the operator sees it inline.
    return {
      id: entry.id,
      label: entry.name,
      meta: entry.errorMessage ?? "Invalid workflow YAML",
      status: "error",
    };
  }
  return { id: entry.id, label: entry.name, entryId: entry.id, facts: candidateFacts(entry) };
}

/** Same name within a section: reveal version/source/path so the rows can be
 * told apart without opening them (never by ID fragments). */
function disambiguate(rows: LibraryRow[]): LibraryRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  return rows.map((row) => ((counts.get(row.label) ?? 0) > 1 ? row : { ...row, facts: undefined }));
}

function contextPackRow(entry: ContextPackEntry): LibraryRow {
  return {
    id: entry.id,
    label: entry.name,
    entryId: entry.id,
    facts: `v${entry.version} · ${entry.sourceType} · ${entry.relativePath}`,
  };
}

function agentImageRow(entry: AgentImageEntry): LibraryRow {
  const parts: string[] = [`v${entry.version}`];
  if (entry.derivedEstimatedTokens > 0) parts.push(`~${entry.derivedEstimatedTokens} tok`);
  if (entry.stats.forkCount > 0) parts.push(`forks: ${entry.stats.forkCount}`);
  if (entry.stats.lastUsedAt) parts.push(`used: ${formatRelativeAge(entry.stats.lastUsedAt)}`);
  return {
    id: entry.id,
    label: entry.name,
    meta: parts.join(" · "),
    entryId: entry.id,
    facts: `${entry.sourceType} · ${entry.sourcePath}`,
  };
}

function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Origin + freshness + failure for one library list, independent of others. */
function ReadStatus({ id, query, origin }: { id: string; query: ReadQuery; origin: string }) {
  const state = sectionState(query);
  const message = query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "";
  const retry = (
    <button type="button" onClick={() => void query.refetch()} className="ml-2 underline decoration-dotted hover:text-on-surface" data-testid={`library-section-${id}-retry`}>
      Retry
    </button>
  );
  return (
    <div data-testid={`library-section-${id}-read`} data-state={state} className="border-b border-outline-variant/60 px-3 py-1.5 font-mono text-[10px] leading-snug text-on-surface-variant">
      <span>From {origin}</span>
      {state === "ok" && <span> · read {readAge(query.dataUpdatedAt)}</span>}
      {state === "stale" && (
        <span role="status" className="text-amber-800"> · showing the list read {readAge(query.dataUpdatedAt)}; the latest refresh failed: {message}{retry}</span>
      )}
      {state === "failed" && (
        <span role="alert" className="text-red-800"> · unavailable: {message}{retry}</span>
      )}
    </div>
  );
}

function LibrarySection({
  id,
  title,
  rows,
  total,
  read,
  emptyLabel,
  badge,
  selectedId,
  onSelect,
  state = "ok",
  sourceHostId,
}: {
  id: string;
  title: string;
  rows: LibraryRow[];
  /** Read state of the list behind this section; only "ok" can claim empty. */
  state?: SectionState;
  /** Unfiltered row count, so "no matches" never reads as an empty source. */
  total: number;
  read?: ReactNode;
  emptyLabel?: string;
  /** Optional aggregate badge shown in the header right slot in place of the
   *  default item count (e.g. agent-images "3 images · 128 MB"). */
  badge?: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Origin of the list query that served these rows' opaque IDs. */
  sourceHostId?: string;
}) {
  const filteredOut = total - rows.length;
  return (
    <section data-testid={`library-section-${id}`} aria-label={title} className="border border-outline-variant bg-surface-lowest/25 hard-shadow">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">{title}</SectionHeader>
        <span
          data-testid={`library-section-${id}-badge`}
          className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant"
        >
          {badge ?? (filteredOut > 0 ? `${rows.length} of ${total}` : `${rows.length} items`)}
        </span>
      </header>
      {read}
      {rows.length > 0 ? (
        <ul className="divide-y divide-outline-variant">
          {rows.map((row) => {
            const selected = row.id === selectedId;
            const rowClass = `block px-3 py-2 ${selected ? "bg-secondary/10 outline outline-1 -outline-offset-1 outline-secondary/50" : ""}`;
            return (
              <li key={row.id}>
                {row.entryId ? (
                  <LibraryEntryLink
                    entryId={row.entryId}
                    sourceHostId={sourceHostId}
                    testId={`library-row-${id}-${row.id}`}
                    data-selected={selected ? "true" : undefined}
                    aria-current={selected ? "true" : undefined}
                    onOpen={() => onSelect(row.id)}
                    className={`${rowClass} hover:bg-surface-low/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-secondary`}
                  >
                    <LibraryRowContent row={row} />
                  </LibraryEntryLink>
                ) : (
                  <div
                    data-testid={`library-row-${id}-${row.id}`}
                    data-status={row.status}
                    className={`${rowClass} ${row.status === "error" ? "bg-red-50/40 text-red-900" : ""}`}
                  >
                    <LibraryRowContent row={row} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="px-3 py-4 font-mono text-[10px] text-on-surface-variant" data-testid={`library-section-${id}-empty`}>
          {state === "loading" ? "Loading…"
            : state === "failed" ? "Entries are unknown until this library can be read."
              : filteredOut > 0 ? `No matches for the current filter (${filteredOut} hidden).` : emptyLabel ?? "No entries."}
        </div>
      )}
    </section>
  );
}

/** Compact human-readable byte size for the agent-image aggregate badge. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function LibraryRowContent({ row }: { row: LibraryRow }) {
  return (
    <div className="min-w-0 font-mono">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="truncate text-xs font-bold text-on-surface">{row.label}</span>
        {row.meta ? (
          <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
            {row.meta}
          </span>
        ) : null}
      </div>
      {row.facts ? (
        <div className="mt-0.5 truncate text-[10px] text-on-surface-variant" data-testid="library-row-facts" title={row.facts}>{row.facts}</div>
      ) : null}
    </div>
  );
}

// Phase 3a slice 3.3 — Plugins library section.
//
// Mirrors SkillsSection's chrome (border + hard-shadow + header with count),
// renders one row per discovered plugin with name, version, runtime support
// badges (claude/codex), source label provenance. Each row links to the
// plugin detail viewer at /plugins/:id.
function PluginsSection({
  plugins,
  total,
  query,
  selectedId,
  onSelect,
}: {
  plugins: PluginEntry[];
  total: number;
  query: ReadQuery;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const state = sectionState(query);
  return (
    <section
      id="library-plugins"
      data-testid="library-section-plugins"
      aria-label="Plugins"
      className="border border-outline-variant bg-surface-lowest/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">Plugins</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {state === "loading" ? "loading" : total > plugins.length ? `${plugins.length} of ${total}` : `${plugins.length} plugins`}
        </span>
      </header>
      <ReadStatus id="plugins" query={query} origin="the connected instance" />
      {plugins.length === 0 ? (
        state === "failed" ? null : (
          <div className="px-3 py-4">
            <EmptyState
              label={state === "loading" ? "LOADING" : total > 0 ? "NO MATCHES" : "NO PLUGINS DISCOVERED"}
              description={state === "loading"
                ? "Loading plugins..."
                : total > 0
                  ? `No plugins match the current filter (${total} hidden).`
                  : "Install a Claude Code or Codex plugin (or wait for openrig-core to vendor) to see it appear here."}
              variant="card"
              testId="library-plugins-empty"
            />
          </div>
        )
      ) : (
        <ul className="divide-y divide-outline-variant">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`library-plugin-${plugin.id}`}
                aria-current={plugin.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(plugin.id)}
                className={`flex items-center gap-3 px-3 py-2 font-mono hover:bg-surface-low/50 ${plugin.id === selectedId ? "bg-secondary/10" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{plugin.name}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillsSection({
  skills,
  total,
  query,
  selectedId,
  onSelect,
}: {
  skills: LibrarySkillEntry[];
  total: number;
  query: ReadQuery;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const state = sectionState(query);
  return (
    <section
      id="library-skills"
      data-testid="library-section-skills"
      aria-label="Skills"
      className="border border-outline-variant bg-surface-lowest/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">Skills</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {state === "loading" ? "loading" : total > skills.length ? `${skills.length} of ${total}` : `${skills.length} folders`}
        </span>
      </header>
      <ReadStatus id="skills" query={query} origin="the connected instance" />
      {skills.length === 0 ? (
        state === "failed" ? null : (
          <div className="px-3 py-4">
            <EmptyState
              label={state === "loading" ? "LOADING" : total > 0 ? "NO MATCHES" : "NO SKILLS FOUND"}
              description={state === "loading"
                ? "Loading skill folders..."
                : total > 0
                  ? `No skills match the current filter (${total} hidden).`
                  : "No .openrig/skills or packaged OpenRig skill folders are visible through configured file roots."}
              variant="card"
              testId="library-skills-empty"
            />
          </div>
        )
      ) : (
        <ul className="divide-y divide-outline-variant">
          {skills.map((skill) => (
            <li key={skill.id}>
              <a
                href={librarySkillHref(skill.id)}
                data-testid={`library-skill-${skill.name}`}
                aria-current={skill.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(skill.id)}
                className={`flex items-center justify-between gap-3 px-3 py-2 font-mono hover:bg-surface-low/50 ${skill.id === selectedId ? "bg-secondary/10" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{skill.name}</span>
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
                  {skill.files.length} files
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Spec authoring without a browser API: say what is supported instead of
 * routing a "Generate"/"Add" label to an unrelated page. */
function AuthoringGuidance() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mb-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        data-testid="specs-toolbar-authoring"
        className="border border-outline-variant bg-surface-lowest/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hard-shadow hover:bg-surface-lowest/40"
      >
        {open ? "Hide authoring options" : "Add or author a spec"}
      </button>
      {open && (
        <div id={panelId} data-testid="specs-authoring-guidance" className="mt-2 max-w-3xl space-y-2 border border-outline-variant bg-surface-lowest/40 px-4 py-3 text-sm leading-relaxed text-on-surface">
          <p>
            <strong>Add an existing spec file:</strong> the browser cannot copy files into the library. Run{" "}
            <code className="font-mono text-xs">rig specs add &lt;path&gt;</code> on this instance; it validates the YAML and the entry appears here on the next read.
          </p>
          <p>
            <strong>Create a rig:</strong> use <Link to="/import" className="underline">Import rig</Link> to validate and preflight YAML, or{" "}
            <Link to="/discovery/inventory" className="underline">Discover</Link> to draft a rig spec from running sessions.
          </p>
          <p data-testid="specs-workflow-generation-unavailable">
            <strong>Workflow generation is not available in the GUI.</strong> Author a workflow YAML in your workspace specs folder
            (<code className="font-mono text-xs">workflows/</code>), starting from a built-in workflow in this library as a template.
            It is listed here on the next read; invalid YAML appears as a diagnostic row. Check it with{" "}
            <code className="font-mono text-xs">rig workflow validate &lt;path&gt;</code>.
          </p>
        </div>
      )}
    </div>
  );
}

function FilterBar({ filter, onChange, shown, total }: {
  filter: CatalogFilter;
  onChange: (next: CatalogFilter) => void;
  shown: number;
  total: number;
}) {
  const textId = useId();
  const kindId = useId();
  const originId = useId();
  const control = "border border-outline-variant bg-surface-lowest px-2 py-1.5 font-mono text-xs text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-secondary";
  return (
    <div role="search" aria-label="Filter the library" className="mb-4 flex flex-wrap items-end gap-3" data-testid="library-filter">
      <label htmlFor={textId} className="flex min-w-[14rem] flex-1 flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
        Filter by name, version or path
        <input
          id={textId}
          type="search"
          value={filter.text}
          onChange={(event) => onChange({ ...filter, text: event.target.value })}
          placeholder="e.g. implementer"
          data-testid="library-filter-text"
          className={`${control} normal-case tracking-normal`}
        />
      </label>
      <label htmlFor={kindId} className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
        Kind
        <select id={kindId} value={filter.kind} onChange={(event) => onChange({ ...filter, kind: event.target.value as CatalogKind })} data-testid="library-filter-kind" className={control}>
          {CATALOG_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
        </select>
      </label>
      <label htmlFor={originId} className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
        Source
        <select id={originId} value={filter.origin} onChange={(event) => onChange({ ...filter, origin: event.target.value as CatalogFilter["origin"] })} data-testid="library-filter-origin" className={control}>
          {CATALOG_ORIGINS.map((origin) => <option key={origin.id} value={origin.id}>{origin.label}</option>)}
        </select>
      </label>
      {isFiltered(filter) && (
        <button type="button" onClick={() => onChange(EMPTY_FILTER)} data-testid="library-filter-clear" className="border border-outline-variant px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-lowest/40">
          Clear
        </button>
      )}
      <div aria-live="polite" data-testid="library-filter-summary" className="w-full font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
        {isFiltered(filter) ? `${shown} of ${total} library entries match` : `${total} library entries visible through current sources`}
      </div>
    </div>
  );
}

export function SpecsLibraryPage() {
  const specsQuery = useSpecLibrary();
  const contextPacksQuery = useContextPackLibrary();
  const agentImagesQuery = useAgentImageLibrary();
  const skillsQuery = useLibrarySkills();
  // Phase 3a slice 3.3 — plugins category.
  const pluginsQuery = usePlugins();
  const specs = specsQuery.data ?? [];
  const contextPacks = contextPacksQuery.data ?? [];
  const agentImages = agentImagesQuery.data ?? [];
  const skills = skillsQuery.data ?? [];
  const plugins = pluginsQuery.data ?? [];

  const hostSelection = useHostSelectionState();
  const specOrigin = hostSelection.state === "known"
    ? originLabel(specsQuery.sourceHostId)
    : `${originLabel(specsQuery.sourceHostId)} (host selection ${hostSelection.state === "failed" ? "unavailable" : "not yet known"})`;

  // The filter lives in the URL search (replace navigations) so Back restores
  // it; the router restores this page's scroll per history entry. The last
  // opened row is session-scoped so returning highlights it without a second
  // navigation racing the row's own push.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const urlFilter = parseCatalogFilter(search);
  // Keystrokes update the visible filter immediately; the URL follows. A URL
  // change we did not write (Back/Forward, a link) replaces the draft.
  const [text, setText] = useState(urlFilter.text);
  const written = useRef<string[]>([]);
  useEffect(() => {
    const index = written.current.indexOf(urlFilter.text);
    if (index >= 0) { written.current = written.current.slice(index + 1); return; }
    written.current = [];
    setText(urlFilter.text);
  }, [urlFilter.text]);
  const filter: CatalogFilter = { ...urlFilter, text };
  const [selectedId, setSelectedId] = useState<string | null>(readLastOpened);
  const navigate = useNavigate();
  const router = useRouter();
  const setFilter = (next: CatalogFilter) => {
    if (next.text !== text) { setText(next.text); written.current.push(next.text); }
    void navigate({ to: router.state.location.pathname as "/specs", search: catalogSearch(next) as never, replace: true });
  };
  const onSelect = (id: string) => { setSelectedId(id); writeLastOpened(id); };

  const showKind = (kind: CatalogKind) => filter.kind === "all" || filter.kind === kind;

  const sections = useMemo(() => {
    const specSection = (kind: CatalogKind) => {
      const all = specs.filter((entry) => specCatalogKind(entry) === kind);
      const shown = all.filter((entry) => matchesOrigin(filter.origin, entry.sourceType)
        && matchesText(filter.text, [entry.name, entry.version, entry.relativePath, entry.summary, entry.errorMessage]));
      return { total: all.length, rows: disambiguate(shown.map(specRow)) };
    };
    const packsShown = contextPacks.filter((entry) => matchesOrigin(filter.origin, entry.sourceType)
      && matchesText(filter.text, [entry.name, entry.version, entry.relativePath, entry.purpose]));
    const imagesShown = agentImages.filter((entry) => matchesOrigin(filter.origin, entry.sourceType)
      && matchesText(filter.text, [entry.name, entry.version, entry.sourceSeat, entry.notes]));
    return {
      rigSpecs: specSection("rig"),
      workflowSpecs: specSection("workflow"),
      agentSpecs: specSection("agent"),
      applications: specSection("application"),
      contextPacks: { total: contextPacks.length, rows: disambiguate(packsShown.map(contextPackRow)) },
      agentImages: { total: agentImages.length, rows: disambiguate(imagesShown.map(agentImageRow)) },
      skills: skills.filter((skill) => matchesOrigin(filter.origin, skill.source) && matchesText(filter.text, [skill.name, skill.id])),
      plugins: plugins.filter((plugin) => matchesOrigin(filter.origin, plugin.source)
        && matchesText(filter.text, [plugin.name, plugin.version, plugin.description, plugin.sourceLabel])),
    };
  }, [specs, contextPacks, agentImages, skills, plugins, filter.origin, filter.text]);

  // OPR.0.4.3.05 — aggregate agent-image status badge (count + total estimated
  // size) over the already-in-scope library array. Rendered into the existing
  // Agent Images section header; no new data wiring, no phantom Steering panel.
  const agentImageBadge = useMemo(() => {
    const count = agentImages.length;
    const totalBytes = agentImages.reduce((sum, e) => sum + (e.stats?.estimatedSizeBytes ?? 0), 0);
    return `${count} ${count === 1 ? "image" : "images"} · ${formatBytes(totalBytes)}`;
  }, [agentImages]);

  const visible = (kind: CatalogKind, count: number) => (showKind(kind) ? count : 0);
  const total = specs.length + contextPacks.length + agentImages.length + skills.length + plugins.length;
  const shown = visible("rig", sections.rigSpecs.rows.length) + visible("workflow", sections.workflowSpecs.rows.length)
    + visible("agent", sections.agentSpecs.rows.length) + visible("application", sections.applications.rows.length)
    + visible("context-pack", sections.contextPacks.rows.length) + visible("agent-image", sections.agentImages.rows.length)
    + visible("skill", sections.skills.length) + visible("plugin", sections.plugins.length);

  const specRead = (id: string) => <ReadStatus id={id} query={specsQuery} origin={specOrigin} />;
  const specState = sectionState(specsQuery);
  // Spec rows link with the origin of the query that served them (selected
  // host); connected-instance libraries are explicitly local.
  const specSource = specsQuery.sourceHostId ?? undefined;

  return (
    <div
      data-testid="specs-library-page"
      data-scroll-restoration-id="specs-library"
      className="h-full overflow-y-auto bg-paper-grid px-4 py-5 sm:px-6 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <SectionHeader tone="muted">Library</SectionHeader>
          <h1 className="mt-1 font-headline text-2xl font-bold tracking-tight text-on-surface">
            Library
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-on-surface-variant">
            Specs, context packs, agent images, applications, and skill folders. Specs follow the selected host;
            the other libraries describe the connected instance.
          </p>
        </div>
        <nav
          aria-label="Library actions"
          className="flex flex-wrap justify-end gap-2"
        >
          {TOOLBAR_ACTIONS.map((a) => (
            <Link
              key={a.testId}
              to={a.to}
              title={a.title}
              data-testid={a.testId}
              className="border border-outline-variant bg-surface-lowest/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hard-shadow hover:bg-surface-lowest/40"
            >
              {a.label}
            </Link>
          ))}
        </nav>
      </header>

      <AuthoringGuidance />
      <FilterBar filter={filter} onChange={setFilter} shown={shown} total={total} />

      <div className="grid gap-4 xl:grid-cols-2">
        {showKind("rig") && (
          <LibrarySection id="rig-specs" title="Rig Specs" {...sections.rigSpecs} read={specRead("rig-specs")} state={specState} sourceHostId={specSource}
            emptyLabel="No rig specs found." selectedId={selectedId} onSelect={onSelect} />
        )}
        {filter.kind === "all" && (
          <LibrarySection id="workspace-specs" title="Workspace Specs" rows={[]} total={0}
            emptyLabel="Workspace specs are not listed separately yet; user-file specs appear under their kind."
            selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("workflow") && (
          <LibrarySection id="workflow-specs" title="Workflow Specs" {...sections.workflowSpecs} read={specRead("workflow-specs")} state={specState} sourceHostId={specSource}
            emptyLabel="No workflow specs found." selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("context-pack") && (
          <LibrarySection id="context-packs" title="Context Packs" {...sections.contextPacks}
            read={<ReadStatus id="context-packs" query={contextPacksQuery} origin="the connected instance" />}
            state={sectionState(contextPacksQuery)} sourceHostId="local"
            emptyLabel="No context packs found." selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("agent") && (
          <LibrarySection id="agent-specs" title="Agent Specs" {...sections.agentSpecs} read={specRead("agent-specs")} state={specState} sourceHostId={specSource}
            emptyLabel="No agent specs found." selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("agent-image") && (
          <LibrarySection id="agent-images" title="Agent Images" {...sections.agentImages}
            read={<ReadStatus id="agent-images" query={agentImagesQuery} origin="the connected instance" />}
            state={sectionState(agentImagesQuery)} sourceHostId="local"
            emptyLabel="No agent images found." badge={agentImagesQuery.isLoading ? "loading" : agentImageBadge}
            selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("application") && (
          <LibrarySection id="applications" title="Applications" {...sections.applications} read={specRead("applications")} state={specState} sourceHostId={specSource}
            emptyLabel="No application specs found." selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>

      <div className="mt-4 space-y-4">
        {/* Phase 3a slice 3.3 — Plugins category sits between the spec
            grid and the Skills folder roundup; both are wide single-
            column sections rather than grid columns because their row
            count varies more dramatically than the spec categories. */}
        {showKind("plugin") && (
          <PluginsSection plugins={sections.plugins} total={plugins.length} query={pluginsQuery} selectedId={selectedId} onSelect={onSelect} />
        )}
        {showKind("skill") && (
          <SkillsSection skills={sections.skills} total={skills.length} query={skillsQuery} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

const LAST_OPENED_KEY = "openrig.library.lastOpened.v1";
function readLastOpened(): string | null {
  try { return window.sessionStorage.getItem(LAST_OPENED_KEY); } catch { return null; }
}
function writeLastOpened(id: string) {
  try { window.sessionStorage.setItem(LAST_OPENED_KEY, id); } catch { /* memory only */ }
}
