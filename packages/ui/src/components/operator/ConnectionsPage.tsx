// Connections — passive gateway observability for the connected instance
// (/api/gateway/connections, manifest on explicit reveal).
//
// Four facts stay distinct and none is promoted to another: configured
// (current file), running (gateway built at activation), applied (current
// config matches the running build) and a dated verification. Current
// external reachability is never observed by this page. Browsing never
// contacts Slack, verifies, applies or writes gateway state.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import { useGatewayConnections, useSlackManifest, type GatewayConnections } from "../../hooks/useGatewayConnections.js";
import {
  CopyButton, DetailSection, Field, Fields, ListDetailLayout, LoadingBlock, OperatorPageHeader, OperatorReadGate, ReadFailure,
  ReadStatusBar, SearchInput, Tag, Timestamp, listKeyboardHandler, useUrlSyncedText, type Tone,
} from "./OperatorPrimitives.js";
import { validateConnectionsSearch, type ConnectionsSearch } from "./operator-search.js";
import { matchesQuery } from "./attention-model.js";
import { HumanRequests, InboundDestination, useConnectionsContext, WorkAndConfiguration, type ConnectionsContextData } from "./ConnectionsContext.js";

type Human = GatewayConnections["humans"][number];

function appliedText(applied: GatewayConnections["running"]["applied"]): string {
  switch (applied) {
    case "matching": return "Current configuration matches what the running gateway was built from.";
    case "changed": return "Configuration changed since the running gateway was built. Do not assume it is applied.";
    case "unverified": return "Whether the running gateway uses the current configuration is unverified.";
  }
}

function readyText(value: boolean | null): string {
  return value === null ? "unreported" : value ? "configured at activation" : "not configured at activation";
}

function verificationTone(state: GatewayConnections["verification"]["state"]): Tone {
  return state === "failed" ? "bad" : state === "ready-at-check" ? "neutral" : "warn";
}

export function humanRouteText(human: Human, gatewayState: string): string {
  if (human.excluded === true) return "Excluded by outbound policy";
  if (human.excluded === null) return "Route eligibility unknown";
  return `Eligible for the instance Slack route · gateway ${gatewayState}`;
}

export function ConnectionsPage() {
  const search = validateConnectionsSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  const connections = useGatewayConnections(LOCAL_OPERATOR_INSTANCE);
  const context = useConnectionsContext();
  // Selection pushes history; the humans filter replaces it. Both merge into
  // the current URL state, so detail → Back restores selection and filter.
  const selectHuman = (human: string | undefined) => void navigate({
    to: "/settings/connections", search: (prev: Record<string, unknown>) => ({ ...validateConnectionsSearch(prev), human }),
  });
  const setFilters = useCallback((patch: Partial<ConnectionsSearch>) => void navigate({
    to: "/settings/connections", search: (prev: Record<string, unknown>) => ({ ...validateConnectionsSearch(prev), ...patch }), replace: true,
  }), [navigate]);
  const writeQuery = useCallback((q: string | undefined) => setFilters({ q }), [setFilters]);
  const [query, setQuery] = useUrlSyncedText(search.q, writeQuery);

  return (
    <div data-testid="operator-connections-page" className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
      <OperatorPageHeader
        testId="operator-connections"
        title="Connections"
        description="Passive view of the Slack gateway and the human registry. Refreshing reads the daemon's projection only; it sends nothing and does not contact Slack."
      />
      <OperatorReadGate query={connections} what="Connections" testId="connections">
        {() => {
          const c = connections.data!;
          return (
            <>
              <ReadStatusBar query={connections} servedAt={c.observedAt} servedLabel="observed" testId="connections-read" />
              <GatewaySummary c={c} />
              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                <SlackConfiguration c={c} context={context} />
                <RunningGateway c={c} />
              </div>
              <div className="mt-4"><InstanceSettings c={c} /></div>
              <div className="mt-4"><SlackManifestReveal /></div>
              <HumansRegistry c={c} selected={search.human} onSelect={selectHuman} query={query} onQuery={setQuery} context={context} />
              <WorkAndConfiguration context={context} />
            </>
          );
        }}
      </OperatorReadGate>
    </div>
  );
}

function GatewaySummary({ c }: { c: GatewayConnections }) {
  return (
    <section data-testid="connections-summary" aria-label="Gateway summary" className="border border-on-surface bg-surface-lowest px-4 py-3 hard-shadow">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Slack gateway</span>
        <Tag tone={c.state === "failed" || c.state === "unavailable" ? "bad" : "warn"} testId="connections-state">{c.state}</Tag>
        <Tag tone="muted">humans {c.registry.state === "available" ? c.humans.length : "unknown"}</Tag>
      </div>
      <p className="mt-2 text-sm text-on-surface">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Next · </span>
        <span data-testid="connections-next-action" className="break-words [overflow-wrap:anywhere]">{c.nextAction}</span>
      </p>
      <table data-testid="connections-matrix" className="mt-3 w-full border-collapse text-left text-xs">
        <caption className="sr-only">Gateway facts and what each one establishes</caption>
        <tbody className="divide-y divide-outline-variant">
          <MatrixRow fact="Configured" value={c.configuration ? (c.configuration.enabled ? "enabled in current file" : "disabled in current file") : `unavailable (${c.configSource.sourceState})`} meaning="What the configuration file says now." testId="connections-matrix-configured" />
          <MatrixRow fact="Running" value={<>{c.running.state}{c.running.activatedAt ? <> since <Timestamp iso={c.running.activatedAt} /></> : null}</>} meaning="The gateway process state as last built." testId="connections-matrix-running" />
          <MatrixRow fact="Applied" value={c.running.applied} meaning={appliedText(c.running.applied)} testId="connections-matrix-applied" />
          <MatrixRow fact="Last check" value={c.verification.at ? <>{c.verification.state} at <Timestamp iso={c.verification.at} /></> : `${c.verification.state} · no dated check`} meaning="A dated scopes/channel check. Not delivery, current credentials or readership." testId="connections-matrix-verified" />
          <MatrixRow fact="External reach" value="not observed" meaning="This view never contacts Slack; current reachability is unknown here." testId="connections-matrix-reach" />
        </tbody>
      </table>
    </section>
  );
}

function MatrixRow({ fact, value, meaning, testId }: { fact: string; value: ReactNode; meaning: string; testId: string }) {
  return (
    <tr data-testid={testId} className="align-top">
      <th scope="row" className="w-28 py-1.5 pr-3 font-mono text-[10px] font-normal uppercase tracking-[0.1em] text-on-surface-variant">{fact}</th>
      <td className="py-1.5 pr-3 font-mono text-on-surface [overflow-wrap:anywhere]">
        {value}
        {/* Narrow screens keep the meaning, stacked under the value. */}
        <span className="mt-0.5 block font-sans text-on-surface-variant sm:hidden">{meaning}</span>
      </td>
      <td className="hidden py-1.5 text-on-surface-variant sm:table-cell">{meaning}</td>
    </tr>
  );
}

function SlackConfiguration({ c, context }: { c: GatewayConnections; context: ConnectionsContextData }) {
  const cfg = c.configuration;
  return (
    <section data-testid="connections-configuration" className="border border-outline-variant px-4 py-3">
      <DetailSection title="Slack · configuration (current file)" note="Credential values are never shown; only whether they resolve.">
        <Fields>
          <Field label="Source">{c.configSource.state} · {c.configSource.sourceState}</Field>
          <Field label="Path" copy={c.configSource.path ?? undefined}><span className="font-mono text-xs">{c.configSource.path ?? "unreported"}</span></Field>
          {cfg ? (
            <>
              <Field label="Enabled">{String(cfg.enabled)}</Field>
              <Field label="Channel">{cfg.channel ?? "missing"}</Field>
              <Field label="New inbound" testId="connections-inbound-field"><InboundDestination destination={cfg.inboundDestination} context={context} /></Field>
              <Field label="Outbound to">{cfg.outboundDestinations.length ? cfg.outboundDestinations.map((d) => d ?? "unreported").join(", ") : "none"}</Field>
              <Field label="Posting level">posts at {cfg.postLevel} and above; interrupts at {cfg.interruptLevel} and above</Field>
              <Field label="Credentials" testId="connections-credentials">bot {cfg.botToken} · Socket Mode app {cfg.appToken} (values hidden)</Field>
            </>
          ) : <Field label="Configuration">unavailable · no disabled or default state is inferred</Field>}
        </Fields>
        {cfg ? <p className="mt-2 text-xs text-on-surface-variant">Replies follow their existing conversation; new or unmapped inbound uses the configured destination above.</p> : null}
      </DetailSection>
    </section>
  );
}

function RunningGateway({ c }: { c: GatewayConnections }) {
  return (
    <section data-testid="connections-running" className="border border-outline-variant px-4 py-3">
      <DetailSection title="Running gateway & last check">
        <Fields>
          <Field label="State">{c.running.state}</Field>
          <Field label="Activated"><Timestamp iso={c.running.activatedAt} fallback="not activated" /></Field>
          <Field label="Outbound">{readyText(c.running.outboundReady)}</Field>
          <Field label="Inbound">{readyText(c.running.inboundReady)} · {c.running.inboundState}</Field>
          <Field label="Applied" testId="connections-applied">{c.running.applied} — {appliedText(c.running.applied)}</Field>
          <Field label="Last check" testId="connections-verification">
            <Tag tone={verificationTone(c.verification.state)}>{c.verification.state}</Tag>{" "}
            {c.verification.at ? <><Timestamp iso={c.verification.at} /> · {c.verification.actor ?? "actor unknown"}</> : "no matching check in the bounded audit tail"}
          </Field>
        </Fields>
        <p data-testid="connections-verification-caveat" className="mt-2 text-xs text-on-surface-variant">
          A check records scopes and channel membership at that time. It does not prove delivery, current credentials, readership or current reachability.
          Verification and enable/disable are explicit CLI actions on this instance (e.g. <span className="font-mono">rig slack verify</span>, which contacts Slack).
        </p>
      </DetailSection>
    </section>
  );
}

function InstanceSettings({ c }: { c: GatewayConnections }) {
  return (
    <section data-testid="connections-settings" className="border border-outline-variant px-4 py-3">
      <DetailSection title="Instance & process" note="Current settings, not proof of runtime adoption. Environment overrides file overrides default.">
        <Fields>
          <Field label="Process">PID {c.pid}</Field>
          <Field label="Home" copy={c.home ?? undefined}><span className="font-mono text-xs">{c.home ?? "unreported"}</span></Field>
          <Field label="Settings source"><span className="font-mono text-xs">{c.settingsSource ?? "unavailable"}</span></Field>
          {c.settings.map((s) => <Field key={s.key} label={s.key}><span className="font-mono text-xs">{s.value ?? "unavailable"}</span> ({s.source})</Field>)}
        </Fields>
      </DetailSection>
    </section>
  );
}

/** The manifest read is enabled only after an explicit reveal. It reads the
 * daemon's served manifest; it does not contact Slack. */
function SlackManifestReveal() {
  const [revealed, setRevealed] = useState(false);
  const manifest = useSlackManifest(LOCAL_OPERATOR_INSTANCE, { enabled: revealed });
  return (
    <section data-testid="connections-manifest" className="border border-outline-variant px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">Own Slack app · manifest</h3>
        <button
          type="button" data-testid="connections-manifest-toggle" aria-expanded={revealed} onClick={() => setRevealed((v) => !v)}
          className="border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
        >
          {revealed ? "Hide manifest" : "Show manifest"}
        </button>
      </div>
      <p className="mt-1 text-xs text-on-surface-variant">Reads the manifest this daemon serves. Nothing is sent to Slack; creating the app happens in Slack after you open the link yourself.</p>
      {revealed ? (
        manifest.data ? (
          <div className="mt-3 space-y-3" data-testid="connections-manifest-body">
            {/* Its own read: a failed refresh keeps the earlier YAML, dated and labeled. */}
            <ReadStatusBar query={manifest} testId="connections-manifest-read" what="Slack manifest" />
            <Fields>
              <Field label="Create-app link" copy={manifest.data.url}>
                <a href={manifest.data.url} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-xs underline">{manifest.data.url}</a>
              </Field>
              <Field label="Bot scopes">{manifest.data.scopes.join(", ") || "none"}</Field>
              <Field label="Bot events">{manifest.data.events.join(", ") || "none"}</Field>
              <Field label="App name">{manifest.data.manifest.display_information.name} · {manifest.data.manifest.display_information.description}</Field>
              <Field label="Bot user">{manifest.data.manifest.features.bot_user.display_name} · always online {String(manifest.data.manifest.features.bot_user.always_online)}</Field>
              <Field label="Settings">Socket Mode {String(manifest.data.manifest.settings.socket_mode_enabled)} · interactivity {String(manifest.data.manifest.settings.interactivity.is_enabled)} · org deploy {String(manifest.data.manifest.settings.org_deploy_enabled)} · token rotation {String(manifest.data.manifest.settings.token_rotation_enabled)}</Field>
            </Fields>
            <div>
              <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase text-on-surface-variant">Manifest YAML</span><CopyButton value={manifest.data.yaml} label="Copy YAML" /></div>
              <pre data-testid="connections-manifest-yaml" className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-surface-low p-2 font-mono text-[11px] text-on-surface [overflow-wrap:anywhere]">{manifest.data.yaml}</pre>
            </div>
            <p className="text-xs text-on-surface-variant">Then on this instance: <span className="font-mono">rig slack setup</span>, <span className="font-mono">rig slack verify</span>, <span className="font-mono">rig slack enable</span>.</p>
          </div>
        ) : manifest.error ? (
          <div className="mt-3"><ReadFailure error={manifest.error} what="Slack manifest" onRetry={() => void manifest.refetch()} testId="connections-manifest-error" /><p className="mt-1 text-xs text-on-surface-variant">Fallback on this instance: <span className="font-mono">rig slack manifest --url</span>.</p></div>
        ) : <div className="mt-3"><LoadingBlock label="the Slack manifest" /></div>
      ) : null}
    </section>
  );
}

function HumansRegistry({ c, selected, onSelect, query, onQuery, context }: {
  c: GatewayConnections; selected: string | undefined; onSelect: (key: string | undefined) => void;
  query: string; onQuery: (value: string) => void; context: ConnectionsContextData;
}) {
  // The selected person stays inspectable even when the filter hides their row.
  const human = c.humans.find((h) => h.browserKey === selected);
  const visible = useMemo(() => c.humans.filter((h) => matchesQuery([h.displayName, h.entityId, h.address, h.availability], query)), [c.humans, query]);
  return (
    <section data-testid="connections-humans" aria-label="External humans" className="mt-6 border-t border-outline-variant pt-4">
      <h2 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">External humans · instance registry</h2>
      <p className="mb-2 text-xs text-on-surface-variant">
        Registry <span data-testid="connections-registry-state">{c.registry.state}</span>{c.registry.path ? <> · <span className="font-mono">{c.registry.path}</span></> : null}.
        Registration assigns no rig and proves no reachability; the primary binding is the declared default.
      </p>
      {c.registry.state !== "available" ? (
        <p data-testid="connections-registry-unavailable" className="border border-warning px-3 py-2 text-sm">Registry unavailable; recipients are unknown. On this instance: <span className="font-mono">rig gateway human list --json</span>.</p>
      ) : c.humans.length === 0 ? (
        <p data-testid="connections-humans-empty" className="border border-dashed border-outline-variant px-3 py-3 text-sm text-on-surface-variant">No registered humans. On this instance: <span className="font-mono">rig gateway human add --help</span>.</p>
      ) : (
        <ListDetailLayout
          testId="connections-humans-layout" listLabel="All humans" hasSelection={Boolean(selected)} onClearSelection={() => onSelect(undefined)}
          list={(
            <div className="space-y-2">
            <SearchInput label="Filter people" testId="connections-humans-filter" value={query} onChange={onQuery} placeholder="name, entity, address" />
            {visible.length === 0 ? (
              <p data-testid="connections-humans-filter-empty" className="border border-dashed border-outline-variant px-3 py-3 text-sm text-on-surface-variant">No registered person matches “{query}”. {c.humans.length} hidden by the filter.</p>
            ) : (
            <ul onKeyDown={listKeyboardHandler} aria-label="Registered humans" className="divide-y divide-outline-variant border border-outline-variant">
              {visible.map((h) => (
                <li key={h.browserKey}>
                  <button
                    type="button" data-list-item data-testid={`connections-human-${h.entityId}`} aria-current={h.browserKey === selected ? "true" : undefined}
                    onClick={() => onSelect(h.browserKey)}
                    className={cn("block w-full px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface", h.browserKey === selected ? "bg-surface-low" : "hover:bg-surface-low/60")}
                  >
                    <span className="block break-words text-sm text-on-surface [overflow-wrap:anywhere]">{h.displayName ?? h.entityId}</span>
                    <span className="block break-all font-mono text-[10px] text-on-surface-variant">{h.address}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Tag tone={h.excluded === true ? "warn" : "muted"}>{h.excluded === true ? "excluded" : h.excluded === null ? "eligibility unknown" : "eligible"}</Tag>
                      <Tag tone={h.availability === "available" ? "neutral" : "muted"}>{h.availability}</Tag>
                      {h.away ? <Tag tone="warn">away</Tag> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            )}
            </div>
          )}
          detail={selected && !human ? (
            <p role="alert" data-testid="connections-human-missing" className="border border-warning px-3 py-2 text-sm">This person is no longer in the registry read.</p>
          ) : human ? <HumanDetail human={human} gatewayState={c.state} context={context} /> : (
            <p className="border border-dashed border-outline-variant px-4 py-6 text-sm text-on-surface-variant">Select a person to see identity, delivery preferences and bindings.</p>
          )}
        />
      )}
    </section>
  );
}

function HumanDetail({ human, gatewayState, context }: { human: Human; gatewayState: string; context: ConnectionsContextData }) {
  return (
    <article data-testid="connections-human-detail" aria-label={human.displayName ?? human.entityId} className="space-y-3 border border-on-surface bg-surface-lowest px-4 py-3">
      <h3 className="break-words font-headline text-lg font-bold text-on-surface [overflow-wrap:anywhere]">{human.displayName ?? human.entityId}</h3>
      <DetailSection title="Identity & delivery">
        <Fields>
          <Field label="Entity ID" copy={human.entityId}><span className="font-mono text-xs">{human.entityId}</span></Field>
          <Field label="Address" copy={human.address}><span className="font-mono text-xs">{human.address}</span></Field>
          <Field label="Class">{human.class}</Field>
          <Field label="Delivery class">{human.deliveryClass}</Field>
          <Field label="Availability">{human.availability}</Field>
          <Field label="Away" testId="connections-human-away">{human.away === null ? "unknown" : human.away ? "yes" : "no"}</Field>
          <Field label="Route" testId="connections-human-route">{humanRouteText(human, gatewayState)}</Field>
        </Fields>
      </DetailSection>
      <DetailSection title={`Bindings · ${human.bindings.length}`}>
        {human.bindings.length === 0 ? <p className="text-sm text-on-surface-variant">No bindings registered.</p> : (
          <ul className="space-y-2">
            {human.bindings.map((b) => (
              <li key={b.browserKey} data-testid="connections-human-binding" className="border border-outline-variant px-3 py-2">
                <Fields>
                  <Field label="Role">{b.role}</Field>
                  <Field label="Kind">{b.kind}</Field>
                  <Field label="Reference"><span className="font-mono text-xs">{b.ref ?? "unreported"}</span></Field>
                  <Field label="Handle">{b.handle ?? "absent (outbound only)"}</Field>
                  <Field label="Credential ref">{b.credentialReference ? "present (contents withheld)" : "none"}</Field>
                </Fields>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <HumanRequests address={human.address} context={context} />
      <p className="text-xs text-on-surface-variant">Inspecting binding readiness contacts Slack and stays an explicit CLI action: <span className="font-mono">rig gateway human show {human.entityId} --json</span>.</p>
    </article>
  );
}
