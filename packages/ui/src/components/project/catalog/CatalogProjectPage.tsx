// /project/catalog — exact catalog project selection.
//
// The configured default workspace (/project) is unchanged; this page is the
// explicit alternative. Selection is project ID + canonical root in the URL,
// carried by every read and cache key. An unknown, moved or unavailable
// selection is reported with an intentional reselection — never resolved by
// name and never substituted with the default workspace. All reads describe
// the connected instance (LOCAL_OPERATOR_INSTANCE) only.

import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { CanonicalScopes, CatalogProject, ProjectSelection } from "../../../lib/project-read.js";
import { LOCAL_OPERATOR_INSTANCE, type OperatorReadError } from "../../../lib/operator-read.js";
import { useProjectCatalog } from "../../../hooks/useProjectCatalog.js";
import { useCanonicalScopes } from "../../../hooks/useCanonicalScopes.js";
import { SectionHeader } from "../../ui/section-header.js";
import { DisplayZoneNote } from "../../time/DisplayTime.js";
import { cn } from "../../../lib/utils.js";
import { ConnectedInstanceNote, CopyButton, Disclose, listKeyboard, Panel, ReadError, ReadGate, ReadStatus, Tag, type ReadLike } from "./evidence-ui.js";
import { MissionOutcomeLine } from "./OutcomeEvidence.js";
import { MissionExecution } from "./MissionExecution.js";
import { SliceEvidence } from "./SliceEvidence.js";
import { ProjectCatalogChooser } from "./ProjectCatalogChooser.js";
import {
  locationForProject, matchCatalogSelection, PROJECT_IDENTITY_CODES, selectionFromLocation, type CatalogLocation,
} from "./project-location.js";
import { useCatalogLocation, type CatalogNavigate } from "./useCatalogLocation.js";

export function CatalogProjectRoute() {
  const { location, go } = useCatalogLocation();
  return <CatalogProjectView location={location} go={go} />;
}

function Crumbs({ location, name, go }: { location: CatalogLocation; name: string | null; go: CatalogNavigate }) {
  const base = { project: location.project, projectRoot: location.projectRoot };
  const items: Array<{ label: string; to: CatalogLocation | null }> = [{ label: "Catalog", to: {} }];
  if (location.project) items.push({ label: name ?? location.project, to: location.mission ? base : null });
  if (location.mission) items.push({ label: location.mission, to: location.slice ? { ...base, mission: location.mission } : null });
  if (location.slice) items.push({ label: location.slice, to: null });
  return (
    <nav aria-label="Project location" data-testid="catalog-crumbs" className="flex flex-wrap items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span aria-hidden>▸</span> : null}
          {item.to ? <button type="button" className="uppercase underline-offset-2 hover:text-on-surface hover:underline" onClick={() => go(item.to!)}>{item.label}</button>
            : <span aria-current="page" className="text-on-surface">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

function SelectionProblem({ title, children, testId, onCatalog }: { title: string; children: ReactNode; testId: string; onCatalog: () => void }) {
  return (
    <div role="alert" data-testid={testId} className="border border-tertiary bg-surface-lowest px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">{title}</div>
      <div className="mt-1 text-sm text-on-surface">{children}</div>
      <p className="mt-1 text-xs text-on-surface-variant">Nothing was read from another project or from the configured default workspace.</p>
      <button type="button" data-testid={`${testId}-catalog`} onClick={onCatalog}
        className="mt-2 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low">Choose from catalog</button>
    </div>
  );
}

function CatalogDrift({ projects, selection, onChoose, onCatalog }: { projects: CatalogProject[]; selection: ProjectSelection; onChoose: (p: CatalogProject) => void; onCatalog: () => void }) {
  const match = matchCatalogSelection(projects, selection);
  if (match.kind === "listed") return null;
  const id = <span className="font-mono">{selection.id}</span>;
  const root = <span className="break-all font-mono">{selection.root}</span>;
  return (
    <SelectionProblem testId={`catalog-selection-${match.kind}`} onCatalog={onCatalog}
      title={match.kind === "moved" ? "Project root changed" : match.kind === "renamed" ? "Root now listed under another ID" : "Project not in catalog"}>
      {match.kind === "moved" ? <>The catalog now lists {id} at a different root. This link points at {root}.</> : null}
      {match.kind === "renamed" ? <>The root {root} is now catalogued under a different ID, not {id}.</> : null}
      {match.kind === "absent" ? <>The catalog no longer lists {id} at {root}.</> : null}
      {match.kind !== "absent" ? (
        <ul className="mt-2 space-y-1">
          {match.current.map((p) => (
            <li key={`${p.id}:${p.root}`}>
              <button type="button" data-testid={`catalog-reselect-${p.id}`} onClick={() => onChoose(p)} disabled={p.error !== undefined}
                className="border border-outline-variant px-2 py-0.5 text-left text-xs hover:border-on-surface disabled:opacity-60">
                Open {p.name} · <span className="font-mono">{p.id}</span> at <span className="break-all font-mono">{p.root}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </SelectionProblem>
  );
}

function identityErrorExtra(error: OperatorReadError | null) {
  if (!error?.serverCode || !PROJECT_IDENTITY_CODES.has(error.serverCode)) return null;
  return <p data-testid="catalog-identity-error" className="mt-1 text-sm text-on-surface">This exact selection no longer resolves on the connected instance. Choose the project again from the catalog; the old root is not followed automatically.</p>;
}

function ProjectOverview({ scopes, location, go }: { scopes: CanonicalScopes; location: CatalogLocation; go: CatalogNavigate }) {
  const base = { project: location.project, projectRoot: location.projectRoot };
  return (
    <div className="space-y-4" data-testid="project-overview">
      {scopes.readErrors.length ? (
        <div role="alert" data-testid="project-read-errors" className="border border-warning px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">Partial read · {scopes.readErrors.length} source{scopes.readErrors.length === 1 ? "" : "s"} unavailable</span>
          <ul className="mt-1 list-disc pl-5">{scopes.readErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      ) : null}
      <Panel title="Missions" testId="project-missions" note="Each mission of this exact project, with native outcome readiness. Open a mission for its execution story.">
        {scopes.missions.length === 0 ? <p className="text-sm text-on-surface-variant">This project serves no missions.</p> : (
          <ul onKeyDown={(e) => listKeyboard(e)} className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {scopes.missions.map((m) => (
              <li key={m.mission}>
                <button type="button" data-nav-item data-testid={`project-mission-${m.mission}`} onClick={() => go({ ...base, mission: m.mission })}
                  className={cn("flex h-full w-full flex-col gap-1 border bg-surface-lowest px-3 py-2 text-left hover:border-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface", m.error ? "border-dashed border-tertiary" : "border-outline-variant")}>
                  <span className="font-headline text-sm font-bold uppercase tracking-tight">{m.mission}</span>
                  {m.error ? <span data-testid={`project-mission-${m.mission}-error`} className="text-xs text-tertiary">Unavailable: {m.error}</span> : (
                    <>
                      <span className="text-xs text-on-surface-variant">{m.slices.length} slice{m.slices.length === 1 ? "" : "s"} · declared {[...new Set(m.slices.map((s) => s.status ?? "no status"))].join(", ") || "none"}</span>
                      <span><MissionOutcomeLine readiness={m.readiness} testId={`project-mission-${m.mission}-native`} /></span>
                    </>
                  )}
                  {scopes.sources[m.mission] ? <span className="break-all font-mono text-[10px] text-on-surface-variant">{scopes.sources[m.mission]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Disclose summary="Project source and observation" testId="project-source">
        <p className="text-xs">Project source <span className="break-all font-mono">{scopes.project.sourcePath ?? "none"}</span> · missions at <span className="break-all font-mono">{scopes.project.missionsRoot}</span></p>
        <p className="mt-1 text-xs">Proof watcher: {scopes.sourceObservation.state} · revision <span className="font-mono">{scopes.sourceObservation.revision}</span>. This describes the daemon’s existing watcher, not proof that this project is watched; use Refresh after editing sources.</p>
      </Disclose>
    </div>
  );
}

export function CatalogProjectView({ location, go }: { location: CatalogLocation; go: CatalogNavigate }) {
  const catalog = useProjectCatalog(LOCAL_OPERATOR_INSTANCE);
  const state = selectionFromLocation(location);
  const selection = state.kind === "selected" ? state.selection : null;
  const scopes = useCanonicalScopes(LOCAL_OPERATOR_INSTANCE, selection);
  const [chooserOpen, setChooserOpen] = useState(false);

  const entry = selection && catalog.data ? catalog.data.projects.find((p) => p.id === selection.id && p.root === selection.root) ?? null : null;
  const name = entry?.name ?? (scopes.data?.project.name ?? null);
  const choose = (project: CatalogProject) => { setChooserOpen(false); go(locationForProject(project)); };
  const toCatalog = () => go({});
  const base = { project: location.project, projectRoot: location.projectRoot };
  const missionScope = location.mission ? scopes.data?.missions.find((m) => m.mission === location.mission) ?? null : null;
  const sliceScope = location.slice ? missionScope?.slices.find((s) => s.dirName === location.slice) ?? null : null;

  const chooser = (
    <ReadGate query={catalog as ReadLike} what="Project catalog" testId="project-catalog-read">
      {() => <ProjectCatalogChooser catalog={catalog.data!} selection={selection} onChoose={choose} />}
    </ReadGate>
  );

  return (
    <div data-testid="catalog-project-page" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
      <header className="mb-4 border-b border-outline-variant pb-4">
        <SectionHeader tone="muted">Projects · exact catalog selection</SectionHeader>
        <h1 data-testid="catalog-project-title" className="mt-1 break-words font-headline text-headline-md font-bold uppercase tracking-tight text-on-surface">
          {selection ? (name ?? selection.id) : "Choose a project"}
        </h1>
        {selection ? (
          <p data-testid="catalog-project-identity" className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-on-surface-variant">
            <span>id {selection.id}</span><span className="break-all">root {selection.root}</span><CopyButton value={selection.root} label="Copy root" />
          </p>
        ) : (
          <p className="mt-1 max-w-[72ch] text-sm text-on-surface-variant">
            Pick an exact project from the workspace catalog. Projects with the same name are told apart by catalog ID and root.
            The configured workspace view is still available at <Link to="/project" className="underline underline-offset-2">Workspace</Link>.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3"><Crumbs location={location} name={name} go={go} /></div>
        <div className="mt-2 space-y-0.5"><ConnectedInstanceNote subject="Project, mission and execution reads" /><DisplayZoneNote testId="catalog-display-zone" /></div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className={cn(selection ? "hidden lg:block" : "block")} data-testid="catalog-sidebar">{chooser}</aside>
        {selection ? (
          <div className="lg:hidden">
            <button type="button" data-testid="catalog-change-project" aria-expanded={chooserOpen} onClick={() => setChooserOpen((v) => !v)}
              className="w-full border border-outline-variant px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] hover:border-on-surface">
              {chooserOpen ? "Hide catalog" : "Change project"}
            </button>
            {chooserOpen ? <div className="mt-2">{chooser}</div> : null}
          </div>
        ) : null}

        <main className="min-w-0" data-testid="catalog-main">
          {state.kind === "none" ? (
            <div data-testid="catalog-no-selection" className="border border-dashed border-outline-variant px-4 py-8 text-center">
              <div className="font-headline text-sm font-bold uppercase tracking-tight">No project selected</div>
              <p className="mx-auto mt-1 max-w-[56ch] text-sm text-on-surface-variant">Nothing is shown until you choose a project. No project is picked automatically, even when only one exists.</p>
            </div>
          ) : null}
          {state.kind === "invalid" ? (
            <SelectionProblem title="Incomplete project link" testId="catalog-selection-invalid" onCatalog={toCatalog}>{state.reason}</SelectionProblem>
          ) : null}
          {selection ? (
            <div className="space-y-4">
              {catalog.data ? <CatalogDrift projects={catalog.data.projects} selection={selection} onChoose={choose} onCatalog={toCatalog} /> : null}
              {catalog.error && !catalog.data ? <ReadError error={catalog.error} what="Project catalog" testId="catalog-unverified" onRetry={() => void catalog.refetch()}>
                <p className="mt-1 text-sm">The selection below could not be checked against the catalog; the daemon still validates every read against the exact ID and root.</p>
              </ReadError> : null}
              <ReadGate query={scopes as ReadLike} what="Project scopes" testId="project-scopes-read" errorExtra={identityErrorExtra}>
                {() => (
                  <>
                    <ReadStatus query={scopes as ReadLike} testId="project-scopes-status" />
                    {!location.mission ? <ProjectOverview scopes={scopes.data!} location={location} go={go} /> : null}
                    {location.mission && !missionScope ? (
                      <div role="alert" data-testid="catalog-mission-unlisted" className="mb-3 border border-warning px-3 py-2 text-sm">
                        Mission <span className="font-mono">{location.mission}</span> is not listed in this project’s scopes. Its execution is still read by exact name below; no other mission is substituted.
                      </div>
                    ) : null}
                    {location.mission && missionScope?.error ? (
                      <div role="alert" data-testid="catalog-mission-error" className="mb-3 border border-tertiary px-3 py-2 text-sm">Mission source unavailable: {missionScope.error}</div>
                    ) : null}
                    {location.mission && !location.slice ? (
                      <MissionExecution selection={selection} mission={location.mission} missionScope={missionScope} view={location.view} packet={location.packet}
                        onView={(view) => go({ ...base, mission: location.mission, view }, { replace: true })}
                        onOpenSlice={(dir) => go({ ...base, mission: location.mission, slice: dir })}
                        onSelectPacket={(packet) => go({ ...base, mission: location.mission, view: "workflows", packet }, { replace: true })} />
                    ) : null}
                    {location.mission && location.slice ? (
                      <>
                        {missionScope && !sliceScope ? (
                          <div role="alert" data-testid="catalog-slice-unlisted" className="mb-3 border border-warning px-3 py-2 text-sm">
                            Slice <span className="font-mono">{location.slice}</span> is not listed in mission {location.mission}’s scope record. Its detail is still read by exact directory.
                          </div>
                        ) : null}
                        <h2 className="mb-2 font-headline text-sm font-bold uppercase tracking-tight" data-testid="catalog-slice-title">
                          {sliceScope?.displayName ?? location.slice}
                          <span className="ml-2 font-mono text-[11px] font-normal normal-case text-on-surface-variant">{location.mission} / {location.slice}{sliceScope?.id ? ` · id ${sliceScope.id}` : ""}</span>
                          {sliceScope?.status ? <span className="ml-2"><Tag tone="muted">declared {sliceScope.status}</Tag></span> : null}
                        </h2>
                        <SliceEvidence selection={selection} mission={location.mission} slice={location.slice} scope={sliceScope} view={location.view} doc={location.doc}
                          onView={(view) => go({ ...base, mission: location.mission, slice: location.slice, view }, { replace: true })}
                          onDoc={(doc) => go({ ...base, mission: location.mission, slice: location.slice, view: "docs", doc })} />
                      </>
                    ) : null}
                  </>
                )}
              </ReadGate>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
