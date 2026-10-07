// User Settings v0 — System drawer Settings tab.
//
// Three sections at v0: Workspace, Files, Progress. Each setting shows
// the resolved value + source (env / file / default) + default.
// Operators set per-key via inline form; Init Workspace button + Reset
// button per setting.
//
// Keep this read+write surface small. The CLI (`rig config get/set/reset`)
// is the canonical agent-edit path.

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  useSettings,
  useSetSetting,
  useResetSetting,
  useInitWorkspace,
  type SettingsKey,
  type ResolvedSetting,
} from "../../hooks/useSettings.js";
import { DisplayTime, DisplayZoneNote } from "../time/DisplayTime.js";

interface SettingsRowProps {
  label: string;
  settingKey: SettingsKey;
  /** Absent when the connected daemon does not serve this key (older or
   * partial settings maps are valid; nothing is invented for them). */
  resolved: ResolvedSetting | undefined;
  testIdPrefix: string;
  /** Presentation-only rows (changed through the CLI, like the TUI). */
  readOnly?: boolean;
}

/** Exact display of a served value: false, 0 and "" stay visible as such. */
export function settingText(value: ResolvedSetting["value"] | null | undefined): string {
  if (value === undefined || value === null) return "—";
  if (value === "") return "(empty)";
  return String(value);
}

function SettingsRow({ label, settingKey, resolved, testIdPrefix, readOnly = false }: SettingsRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(resolved?.value ?? ""));
  const [error, setError] = useState<string | null>(null);
  const setMutation = useSetSetting();
  const resetMutation = useResetSetting();

  if (!resolved) {
    // Not served by this daemon: no value, default, edit or reset target.
    return (
      <div
        data-testid={`${testIdPrefix}-${settingKey}`}
        data-state="unavailable"
        className="border border-dashed border-outline-variant/60 px-3 py-2 space-y-1"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-on-surface truncate">{label}</span>
          <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant shrink-0">not reported</span>
        </div>
        <div data-testid={`${testIdPrefix}-${settingKey}-unavailable`} className="font-mono text-[9px] text-on-surface-variant break-words">
          The connected daemon does not serve {settingKey}; no value or default is assumed. Inspect on that instance:{" "}
          <span className="text-on-surface">rig config get {settingKey} --show-source</span>
        </div>
      </div>
    );
  }

  const isOverridden = resolved.source !== "default";

  const onSave = async () => {
    setError(null);
    try {
      await setMutation.mutateAsync({ key: settingKey, value: draft });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onReset = async () => {
    setError(null);
    try {
      await resetMutation.mutateAsync(settingKey);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      data-testid={`${testIdPrefix}-${settingKey}`}
      data-state="served"
      className="border border-outline-variant/40 bg-surface-lowest/[0.08] px-3 py-2 space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-on-surface truncate">{label}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant shrink-0">
          source: {resolved.source}
        </span>
      </div>
      {editing ? (
        <div className="space-y-1">
          <input
            data-testid={`${testIdPrefix}-${settingKey}-input`}
            aria-label={`${label} value`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full border border-outline-variant bg-surface-lowest/80 px-2 py-1 font-mono text-[10px]"
          />
          <div className="flex gap-2">
            <button
              data-testid={`${testIdPrefix}-${settingKey}-save`}
              onClick={() => void onSave()}
              disabled={setMutation.isPending}
              className="font-mono text-[8px] uppercase border border-outline-variant px-2 py-0.5 hover:bg-surface-high disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(String(resolved.value ?? "")); setError(null); }}
              className="font-mono text-[8px] uppercase text-on-surface-variant hover:text-on-surface"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          <div data-testid={`${testIdPrefix}-${settingKey}-value`} className="font-mono text-[10px] text-on-surface break-all">{settingText(resolved.value)}</div>
          <div data-testid={`${testIdPrefix}-${settingKey}-default`} className="font-mono text-[8px] text-on-surface-variant break-all">default: {settingText(resolved.defaultValue)}</div>
          {readOnly ? null : (
            <div className="flex gap-1 pt-1">
              <button
                data-testid={`${testIdPrefix}-${settingKey}-edit`}
                // Start each edit from the currently served value, not the
                // value seen when this row first mounted.
                onClick={() => { setDraft(String(resolved.value ?? "")); setEditing(true); setError(null); }}
                className="font-mono text-[8px] uppercase border border-outline-variant px-1 py-0.5 hover:bg-surface-high"
              >
                Edit
              </button>
              {isOverridden && (
                <button
                  data-testid={`${testIdPrefix}-${settingKey}-reset`}
                  onClick={() => void onReset()}
                  disabled={resetMutation.isPending}
                  className="font-mono text-[8px] uppercase border border-outline-variant px-1 py-0.5 hover:bg-surface-high disabled:opacity-50"
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div data-testid={`${testIdPrefix}-${settingKey}-error`} className="font-mono text-[9px] text-red-600">{error}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function SettingsTab() {
  const { data, isLoading, error, dataUpdatedAt, refetch, isFetching } = useSettings();
  const initWorkspace = useInitWorkspace();
  const [initResult, setInitResult] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // The Advisor / Operator rail links here as /settings#agents-{role}-session
  // when no seat is configured. The router's own hash scroll runs before the
  // settings read lands, so scroll to the anchor once the rows exist.
  const router = useRouter({ warn: false });
  const loaded = !!data;
  useEffect(() => {
    if (!loaded) return;
    const hash = router?.state.location.hash;
    if (!hash) return;
    const target = document.getElementById(hash);
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  }, [loaded, router]);

  const onInitWorkspace = async () => {
    setInitError(null);
    setInitResult(null);
    try {
      const r = await initWorkspace.mutateAsync({});
      setInitResult(`Initialized at ${r.root} — created ${r.subdirs.filter((s) => s.created).length} subdir(s).`);
    } catch (err) {
      setInitError((err as Error).message);
    }
  };

  if (isLoading) {
    return <div data-testid="settings-loading" className="px-4 py-3 font-mono text-[10px] text-on-surface-variant">Loading settings…</div>;
  }
  if (!data) {
    // V1 attempt-3 Phase 3 bounce-fix A2 — soften the failure mode.
    // The shipped daemon (npm package) at v0.2.0 doesn't expose /api/config
    // yet; the route lands at v0.3.0. Render an honest empty-state pointing
    // at the CLI (canonical edit path per useSettings.ts header note),
    // not a raw "HTTP 404" red error.
    const errMsg = (error as Error)?.message ?? "";
    const looksLikeMissingEndpoint = errMsg.includes("404");
    return (
      <div
        data-testid="settings-error"
        className="px-4 py-6 font-mono text-xs text-on-surface-variant border border-outline-variant bg-surface-low"
      >
        {looksLikeMissingEndpoint ? (
          <>
            <div className="text-on-surface font-bold uppercase tracking-wide text-[10px] mb-2">
              Settings UI requires daemon ≥ v0.3.0
            </div>
            <p className="mb-2">
              The shipped daemon doesn't expose the settings HTTP route yet.
              Until that lands, configure via the CLI:
            </p>
            <pre className="font-mono text-[10px] bg-background border border-outline-variant px-2 py-1 inline-block">
              rig config get / set / reset
            </pre>
          </>
        ) : (
          <>
            <div className="text-on-surface font-bold uppercase tracking-wide text-[10px] mb-2">
              Settings unavailable
            </div>
            <p>{errMsg || "Daemon is unreachable."}</p>
          </>
        )}
      </div>
    );
  }

  // The reader accepts additive/partial maps (older daemons serve fewer
  // keys); every lookup below may be absent.
  const s = data.settings as Partial<Record<string, ResolvedSetting>>;
  const readAt = dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null;

  return (
    <div data-testid="settings-tab" className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      {error ? (
        <div role="alert" data-testid="settings-stale" className="border border-warning bg-surface-lowest px-3 py-2 font-mono text-[10px]">
          <div className="uppercase tracking-[0.12em] text-warning">Settings refresh failed · showing last successful read</div>
          <p className="mt-1 break-words text-on-surface">{(error as Error).message}</p>
          <p className="mt-1 text-on-surface-variant">
            Values below were read at <DisplayTime iso={readAt} /> and may no longer be current. Saving still writes to the daemon, which validates it.
          </p>
          <button type="button" data-testid="settings-retry" onClick={() => void refetch()} disabled={isFetching}
            className="mt-1 border border-on-surface px-2 py-0.5 uppercase hover:bg-surface-high disabled:opacity-50">
            {isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      <Section title="Workspace">
        <SettingsRow label="Workspace root" settingKey="workspace.root" resolved={s["workspace.root"]} testIdPrefix="setting" />
        <SettingsRow label="Mission/slice root" settingKey="workspace.slices_root" resolved={s["workspace.slices_root"]} testIdPrefix="setting" />
        <SettingsRow label="Steering path" settingKey="workspace.steering_path" resolved={s["workspace.steering_path"]} testIdPrefix="setting" />
        <SettingsRow label="Specs root" settingKey="workspace.specs_root" resolved={s["workspace.specs_root"]} testIdPrefix="setting" />
        <SettingsRow label="Projects root" settingKey="workspace.projects_root" resolved={s["workspace.projects_root"]} testIdPrefix="setting" />
        <SettingsRow label="Project catalog" settingKey="workspace.catalog_path" resolved={s["workspace.catalog_path"]} testIdPrefix="setting" />
        <button
          data-testid="settings-init-workspace"
          onClick={() => void onInitWorkspace()}
          disabled={initWorkspace.isPending}
          className="mt-2 font-mono text-[9px] uppercase border border-outline px-2 py-1 hover:bg-surface-high disabled:opacity-50"
        >
          {initWorkspace.isPending ? "Initializing…" : "Init Workspace"}
        </button>
        {initResult && <div data-testid="settings-init-result" className="font-mono text-[9px] text-on-surface-variant">{initResult}</div>}
        {initError && <div data-testid="settings-init-error" className="font-mono text-[9px] text-red-600">{initError}</div>}
      </Section>

      <Section title="Agents (rail chat seats)">
        <p className="font-mono text-[9px] text-on-surface-variant">
          The Advisor and Operator rail icons open these seats. Use the canonical session name{" "}
          <span className="text-on-surface">member@rig</span>; an empty or non-canonical value opens this section instead.
        </p>
        <div id="agents-advisor-session" className="scroll-mt-3">
          <SettingsRow label="Advisor seat" settingKey="agents.advisor_session" resolved={s["agents.advisor_session"]} testIdPrefix="setting" />
        </div>
        <div id="agents-operator-session" className="scroll-mt-3">
          <SettingsRow label="Operator seat" settingKey="agents.operator_session" resolved={s["agents.operator_session"]} testIdPrefix="setting" />
        </div>
      </Section>

      <Section title="Files (browser allowlist)">
        <SettingsRow label="Allowlist (name:/abs/path,...)" settingKey="files.allowlist" resolved={s["files.allowlist"]} testIdPrefix="setting" />
      </Section>

      <Section title="Progress">
        <SettingsRow label="Scan roots (name:/abs/path,...)" settingKey="progress.scan_roots" resolved={s["progress.scan_roots"]} testIdPrefix="setting" />
      </Section>

      <Section title="Daemon (legacy)">
        <SettingsRow label="Port" settingKey="daemon.port" resolved={s["daemon.port"]} testIdPrefix="setting" />
        <SettingsRow label="Host" settingKey="daemon.host" resolved={s["daemon.host"]} testIdPrefix="setting" />
      </Section>

      <Section title="Display time">
        <SettingsRow label="Timezone (ui.timezone)" settingKey={"ui.timezone" as SettingsKey} resolved={s["ui.timezone"]} testIdPrefix="setting" readOnly />
        <DisplayZoneNote testId="settings-display-zone" />
        <p className="font-mono text-[9px] text-on-surface-variant">
          This browser adopts the connected instance&apos;s value on each settings read. Change it persistently on that instance:{" "}
          <span className="text-on-surface">rig config set ui.timezone Europe/London</span> ·{" "}
          <span className="text-on-surface">rig config reset ui.timezone</span>
        </p>
      </Section>

      <Section title="Database / Transcripts (legacy)">
        <SettingsRow label="DB path" settingKey="db.path" resolved={s["db.path"]} testIdPrefix="setting" />
        <SettingsRow label="Transcripts enabled" settingKey="transcripts.enabled" resolved={s["transcripts.enabled"]} testIdPrefix="setting" />
        <SettingsRow label="Transcripts path" settingKey="transcripts.path" resolved={s["transcripts.path"]} testIdPrefix="setting" />
      </Section>
    </div>
  );
}
