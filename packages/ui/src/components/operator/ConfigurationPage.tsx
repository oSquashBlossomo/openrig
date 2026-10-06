// Configuration browser — read-only inventory of the connected instance's
// resolved settings (/api/config?view=browser).
//
// This is not the editable Settings form (raw general map, /settings). It
// covers general, Slack, people, hosts and health-policy entries with source,
// default, scope and application semantics. A withheld value is never
// rendered, even if a payload were to carry one.

import { useCallback, useMemo } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import { useConfigurationBrowser, type ConfigurationBrowser, type ConfigurationBrowserEntry } from "../../hooks/useConfigurationBrowser.js";
import {
  ChipGroup, DetailSection, Field, Fields, ListDetailLayout, OperatorPageHeader, OperatorReadGate, ReadStatusBar, SearchInput, Tag,
  listKeyboardHandler, useUrlSyncedText, type Tone,
} from "./OperatorPrimitives.js";
import { CONFIGURATION_GROUPS, validateConfigurationSearch, type ConfigurationGroup, type ConfigurationSearch } from "./operator-search.js";
import { matchesQuery } from "./attention-model.js";

const GROUP_LABEL: Record<ConfigurationGroup, string> = {
  general: "General", slack: "Slack", people: "People", hosts: "Hosts", health: "Health policy",
};

function words(value: string): string {
  const s = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Human label. Subject-scoped keys carry an opaque browser key segment, so
 * the label names the subject and the field, never the opaque segment. */
export function configurationLabel(entry: ConfigurationBrowserEntry): string {
  if (entry.subject) {
    const field = entry.key.split(".").slice(2).join(".").replace(/^bindings\.[^.]+\./, "binding ");
    return `${entry.subject} · ${words(field)}`;
  }
  return words(entry.key.replace(/^(?:slack|health\.policy)\./, ""));
}

/** The only place a value is turned into text. Withheld and unavailable
 * entries never expose `value`. */
export function configurationValue(entry: ConfigurationBrowserEntry, which: "value" | "default" = "value"): string {
  if (which === "default" && !entry.defaultKnown) return "Not reported";
  if (entry.visibility === "withheld") return "Contents withheld";
  if (which === "value" && entry.visibility === "unavailable") return "Unavailable";
  const v = which === "default" ? entry.defaultValue : entry.value;
  if (entry.key === "slack.outboundDestinations" && v === "") return "All registered humans";
  if (typeof v === "boolean" && /(?:credentialFile|credentialReference|bearer_env|bearer_file)$/.test(entry.key)) return v ? "Present" : "Missing";
  if (v === null || v === "") return "Unset";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "number") {
    if (/_seconds$|Seconds$/.test(entry.key)) return v >= 60 && v % 60 === 0 ? `${v / 60} min` : `${v} sec`;
    if (entry.key.endsWith("_minutes")) return `${v} min`;
    if (entry.key.endsWith("_days")) return `${v} days`;
    if (entry.key.endsWith("_percent")) return `${v}%`;
  }
  return String(v);
}

function sourceExplanation(entry: ConfigurationBrowserEntry): string {
  switch (entry.source) {
    case "env": return "Environment override (wins over file and default).";
    case "file": return "File setting (wins over default).";
    case "default": return "Default; no override reported.";
    case "unreported": return "Source not reported by this projection.";
    case "unavailable": return "Source unavailable; no value is inferred.";
  }
}

function visibilityTone(entry: ConfigurationBrowserEntry): Tone {
  return entry.visibility === "shown" ? "neutral" : entry.visibility === "withheld" ? "muted" : "warn";
}

function sourceStateTone(state: string): Tone {
  return state === "available" ? "good" : state === "missing" ? "muted" : "warn";
}

export function entryMatchesSelection(entry: ConfigurationBrowserEntry, search: ConfigurationSearch): boolean {
  return entry.key === search.key && (entry.subject ?? undefined) === search.subject;
}

export function ConfigurationPage() {
  const search = validateConfigurationSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  const browser = useConfigurationBrowser(LOCAL_OPERATOR_INSTANCE);
  // Filters/search replace history; selection pushes it. Both merge into the
  // current URL state, never a stale render-time snapshot.
  const setFilters = useCallback((patch: Partial<ConfigurationSearch>) => void navigate({
    to: "/settings/configuration", search: (prev: Record<string, unknown>) => ({ ...validateConfigurationSearch(prev), ...patch }), replace: true,
  }), [navigate]);
  const select = (entry: ConfigurationBrowserEntry | null) => void navigate({
    to: "/settings/configuration", search: (prev: Record<string, unknown>) => ({ ...validateConfigurationSearch(prev), key: entry?.key, subject: entry?.subject }),
  });
  const writeQuery = useCallback((q: string | undefined) => setFilters({ q }), [setFilters]);
  const [query, setQuery] = useUrlSyncedText(search.q, writeQuery);

  return (
    <div data-testid="operator-configuration-page" className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
      <OperatorPageHeader
        testId="operator-configuration"
        title="Configuration"
        description={<>Read-only inventory of resolved settings, their sources and how they apply. Values here are configured, not proof of running adoption. To change editable instance settings use <Link to="/settings" className="underline">Settings</Link>.</>}
      />
      <OperatorReadGate query={browser} what="Configuration browser" testId="configuration">
        {() => (
          <>
            <ReadStatusBar query={browser} servedAt={browser.data!.observedAt} servedLabel="observed" testId="configuration-read" />
            <div className="mb-3 flex flex-col gap-2">
              <ChipGroup
                label="Group" testId="configuration-group" value={search.group ?? "all"}
                options={[{ id: "all", label: "All", count: browser.data!.entries.length }, ...CONFIGURATION_GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g], count: browser.data!.entries.filter((e) => e.group === g).length }))]}
                onChange={(value) => setFilters({ group: value === "all" ? undefined : value })}
              />
              <SearchInput label="Search configuration" testId="configuration-search" value={query} placeholder="label, key, subject"
                onChange={setQuery} />
            </div>
            <ListDetailLayout
              testId="configuration-layout" listLabel="All settings" hasSelection={Boolean(search.key)} onClearSelection={() => select(null)}
              list={<ConfigurationList data={browser.data!} group={search.group} query={query} search={search} onSelect={select} />}
              detail={<ConfigurationDetail data={browser.data!} search={search} />}
            />
            <ConfigurationSources data={browser.data!} />
          </>
        )}
      </OperatorReadGate>
    </div>
  );
}

function ConfigurationList({ data, group, query, search, onSelect }: {
  data: ConfigurationBrowser; group: ConfigurationGroup | undefined; query: string; search: ConfigurationSearch; onSelect: (entry: ConfigurationBrowserEntry) => void;
}) {
  const visible = useMemo(() => data.entries.filter((e) => (!group || e.group === group)
    && matchesQuery([configurationLabel(e), e.key, e.subject], query)), [data.entries, group, query]);
  if (data.entries.length === 0) {
    return <p data-testid="configuration-empty" className="border border-dashed border-outline-variant px-4 py-5 text-sm text-on-surface-variant">No entries served. Check source states below; an empty inventory is not a default configuration.</p>;
  }
  if (visible.length === 0) {
    return <p data-testid="configuration-filter-empty" className="border border-dashed border-outline-variant px-4 py-5 text-sm text-on-surface-variant">No entries match{query ? ` “${query}”` : ""}{group ? ` in ${GROUP_LABEL[group]}` : ""}.</p>;
  }
  return (
    <div onKeyDown={listKeyboardHandler} className="space-y-3" data-testid="configuration-list">
      {CONFIGURATION_GROUPS.filter((g) => visible.some((e) => e.group === g)).map((g) => {
        const entries = visible.filter((e) => e.group === g);
        const state = data.sources.find((s) => s.id === g)?.state;
        return (
          <section key={g} aria-label={GROUP_LABEL[g]} data-testid={`configuration-section-${g}`}>
            <h2 className="mb-1 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">
              {GROUP_LABEL[g]} · {entries.length}
              {state && state !== "available" ? <Tag tone={sourceStateTone(state)}>source {state}</Tag> : null}
            </h2>
            <ul className="divide-y divide-outline-variant border border-outline-variant">
              {entries.map((entry) => {
                const selected = entryMatchesSelection(entry, search);
                const id = `${entry.key}${entry.subject ? `@${entry.subject}` : ""}`;
                return (
                  <li key={id}>
                    <button
                      type="button" data-list-item data-testid={`configuration-row-${id}`} data-key={entry.key} data-subject={entry.subject} aria-current={selected ? "true" : undefined}
                      onClick={() => onSelect(entry)}
                      className={cn("grid w-full grid-cols-1 gap-x-3 px-3 py-1.5 text-left sm:grid-cols-[1fr_auto] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface",
                        selected ? "bg-surface-low" : "hover:bg-surface-low/60")}
                    >
                      <span className="min-w-0 break-words text-sm text-on-surface [overflow-wrap:anywhere]">{configurationLabel(entry)}</span>
                      <span className="flex min-w-0 items-center gap-1.5 sm:justify-end">
                        <span className={cn("break-all font-mono text-xs", entry.visibility === "shown" ? "text-on-surface" : "text-on-surface-variant")}>{configurationValue(entry)}</span>
                        <Tag tone="muted">{entry.source}</Tag>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ConfigurationDetail({ data, search }: { data: ConfigurationBrowser; search: ConfigurationSearch }) {
  if (!search.key) {
    return <p data-testid="configuration-detail-empty" className="border border-dashed border-outline-variant px-4 py-6 text-sm text-on-surface-variant">Select an entry to see its source, default, scope and application.</p>;
  }
  const entry = data.entries.find((e) => entryMatchesSelection(e, search));
  if (!entry) {
    return (
      <div role="alert" data-testid="configuration-detail-missing" className="border border-warning px-4 py-3 text-sm">
        <span className="font-mono text-xs">{search.key}</span>{search.subject ? <> for <span className="font-mono text-xs">{search.subject}</span></> : null} is not in this read. It may have been removed, or its source is unavailable.
      </div>
    );
  }
  const source = data.sources.find((s) => s.id === entry.group);
  return (
    <article data-testid="configuration-detail" aria-label={configurationLabel(entry)} className="space-y-3 border border-on-surface bg-surface-lowest px-4 py-3">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone="muted">{GROUP_LABEL[entry.group]}</Tag>
          <Tag tone={visibilityTone(entry)} testId="configuration-detail-visibility">{entry.visibility}</Tag>
          <Tag tone="muted">read only</Tag>
        </div>
        <h2 className="mt-2 break-words font-headline text-lg font-bold text-on-surface [overflow-wrap:anywhere]">{configurationLabel(entry)}</h2>
      </div>
      <DetailSection title="Value">
        <Fields>
          <Field label="Key" copy={entry.key}><span className="font-mono text-xs">{entry.key}</span></Field>
          {entry.subject ? <Field label="Subject">{entry.subject}</Field> : null}
          <Field label="Value" testId="configuration-detail-value"><span className="font-mono text-xs">{configurationValue(entry)}</span></Field>
          <Field label="Default" testId="configuration-detail-default">
            <span className="font-mono text-xs">{configurationValue(entry, "default")}</span>
            {!entry.defaultKnown ? <span className="ml-1 text-xs text-on-surface-variant">(default not known to this projection)</span> : null}
          </Field>
          {entry.reason ? <Field label="Visibility">{entry.reason}</Field> : null}
        </Fields>
      </DetailSection>
      <DetailSection title="Source & application">
        <Fields>
          <Field label="Source">{entry.source} · {sourceExplanation(entry)}</Field>
          <Field label="Scope">{entry.scope}</Field>
          <Field label="Application" testId="configuration-detail-application">{entry.application}</Field>
          <Field label="Source file" copy={source?.path ?? undefined}>
            {source ? <>{source.path ? <span className="font-mono text-xs">{source.path}</span> : "path withheld or unavailable"} · <Tag tone={sourceStateTone(source.state)}>{source.state}</Tag></> : "not reported"}
          </Field>
          {source ? <Field label="Source note">{source.detail}</Field> : null}
        </Fields>
      </DetailSection>
    </article>
  );
}

function ConfigurationSources({ data }: { data: ConfigurationBrowser }) {
  return (
    <section data-testid="configuration-sources" aria-label="Sources and coverage" className="mt-6 border-t border-outline-variant pt-4">
      <h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">Sources & coverage</h2>
      <Fields>
        <Field label="Instance home" copy={data.home ?? undefined}><span className="font-mono text-xs">{data.home ?? "unavailable"}</span></Field>
        {data.sources.map((s) => (
          <Field key={s.id} label={s.id} testId={`configuration-source-${s.id}`}>
            <Tag tone={sourceStateTone(s.state)}>{s.state}</Tag> <span className="font-mono text-xs">{s.path ?? "path withheld or unavailable"}</span>
            <span className="mt-0.5 block text-xs text-on-surface-variant">{s.detail}</span>
          </Field>
        ))}
      </Fields>
      {data.exclusions.length ? (
        <div className="mt-3" data-testid="configuration-exclusions">
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Not covered here</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-on-surface-variant">{data.exclusions.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-on-surface-variant">Resolved settings describe the connected daemon instance. Rig and project declarations keep their own scopes.</p>
    </section>
  );
}
