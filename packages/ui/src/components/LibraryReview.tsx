import { useState, type ReactNode } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
// OPR.0.4.6.WF4 (C3b) — the workflow shape renderer now lives in its own module
// (extracted from this file); this page imports it. SliceWorkflowGraph untouched.
import { WorkflowTopologyGraph } from "./workflow/WorkflowTopologyGraph.js";
import { WorkflowInstancesBand } from "./workflow/WorkflowInstancesBand.js";
// V1 attempt-3 Phase 5 P5-1: file references in context-pack + agent-image
// "Files" / "Supplementary files" lists become FileReferenceTrigger-wrapped
// rows so click → FileViewer in drawer. Per content-drawer.md L23-L34
// auto-open trigger contract. Content arrives later (Phase 5 P5-5/P5-6
// data-fetch wiring may add live content); FileViewer empty-state covers
// the no-content interim.
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { ForkNowAction } from "./agent-images/ForkNowAction.js";
import {
  useLibraryReview,
  useSpecLibrary,
  useActiveLens,
  useActiveLensActions,
  type LibraryRigReview,
  type LibraryAgentReview,
  type LibraryWorkflowReview,
  type SpecLibraryEntry,
} from "../hooks/useSpecLibrary.js";
import {
  useContextPackLibrary,
  useContextPackPreview,
  type ContextPackEntry,
} from "../hooks/useContextPackLibrary.js";
import {
  useAgentImageLibrary,
  useAgentImagePreview,
  useAgentImagePin,
  type AgentImageEntry,
  type AgentImagePreview,
} from "../hooks/useAgentImageLibrary.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { RigSpecDisplay } from "./RigSpecDisplay.js";
import { buildSetupPrompt } from "../lib/build-setup-prompt.js";
import { copyText } from "../lib/copy-text.js";
import { classifyLibraryReadError, listRead, readAge, resolveAuthoredAgentRef, type ListRead as CatalogRead, type LibraryReadFailure } from "./specs/library-model.js";
import { LibraryEntryLink, originLabel, useHostSelectionState, useLibraryEntryNavigate } from "./specs/library-reads.js";
import { DeclaredByPanel, ObservedSeatsPanel } from "./specs/SpecConsumers.js";

interface LibraryReviewProps {
  entryId: string;
  /** Read origin for spec reviews. undefined = the selected host (existing
   * behaviour); a host ID pins the read to that exact origin; null = origin
   * unknown (no read, no cached evidence). Pass-through only. */
  sourceHostId?: string | null;
}

/** Discloses an explicit read origin; absent for selected-host reads. */
function ReviewOrigin({ sourceHostId }: { sourceHostId: string | null | undefined }) {
  if (sourceHostId === undefined) return null;
  return (
    <div data-testid="library-review-origin" data-source={sourceHostId ?? ""} className="px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
      {sourceHostId === "local" ? "From the connected instance" : sourceHostId === null ? "Spec source unknown" : `From host ${sourceHostId}`}
    </div>
  );
}

function ProvenanceBadge({ sourcePath, sourceState }: { sourcePath: string; sourceState: string }) {
  return (
    <div className="font-mono text-[9px] text-on-surface-variant" data-testid="library-provenance">
      Source: {sourcePath} · {sourceState}
    </div>
  );
}

/** History Back when this entry was reached in-app; otherwise the Library. */
function useBack() {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    const index = (router.state.location.state as { __TSR_index?: number } | undefined)?.__TSR_index;
    if (typeof index === "number" && index > 0) router.history.back();
    else void navigate({ to: "/specs" });
  };
}

/** What was read, from where and when — separate from the launched seats. */
function AuthoredSource({ origin, sourcePath, sourceType, readAt, cached }: {
  origin: string | null;
  sourcePath: string;
  sourceType?: string;
  readAt: number;
  /** Workflow reviews come from the daemon's spec cache, not a current file read. */
  cached?: string;
}) {
  return (
    <div data-testid="library-authored-source" className="space-y-0.5 border-l-2 border-outline-variant pl-3 font-mono text-[11px] leading-relaxed text-on-surface-variant">
      <div>
        Authored source on {originLabel(origin)}: <span className="break-all text-on-surface">{sourcePath}</span>
        {sourceType ? ` · ${sourceType}` : ""}
      </div>
      <div data-testid="library-authored-read">
        {cached
          ? `Cached ${cached}; shown as read ${readAge(readAt)}. Running workflow instances keep their own compiled graph.`
          : `Current file bytes read ${readAge(readAt)}. Seats launched earlier keep the binding recorded at launch.`}
      </div>
    </div>
  );
}

function StaleReview({ error, readAt, onRetry }: { error: unknown; readAt: number; onRetry: () => void }) {
  return (
    <div role="status" data-testid="library-review-stale" className="border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
      The latest refresh failed ({error instanceof Error ? error.message : String(error)}); showing the review read {readAge(readAt)}.{" "}
      <button type="button" className="underline" onClick={onRetry}>Retry</button>
    </div>
  );
}

const FAILURE_COPY: Record<LibraryReadFailure["kind"], { title: string; lead: string }> = {
  reselect: { title: "Reselect This Spec", lead: "This library ID no longer identifies one exact source file (a retired ID, or the file behind it moved). Choose the spec again from the current library." },
  absent: { title: "Spec Not Found", lead: "This library does not contain the requested ID." },
  "unknown-origin": { title: "Spec source unknown", lead: "No known library origin was available, so nothing was read." },
  unavailable: { title: "Library Unavailable", lead: "The library could not be read, so whether this spec exists is unknown." },
};

function ReadFailure({ failure, onRetry, subject = "Spec", testId = "library-review-error" }: {
  failure: LibraryReadFailure;
  onRetry?: () => void;
  subject?: "Spec" | "Context Pack" | "Agent Image";
  testId?: string;
}) {
  const navigate = useNavigate();
  const back = useBack();
  const copy = failure.kind === "absent" && subject !== "Spec"
    ? { title: `${subject} Not Found`, lead: `The connected instance's ${subject.toLowerCase()} library does not list this ID.` }
    : FAILURE_COPY[failure.kind];
  return (
    <WorkspacePage>
      <div data-testid={testId} data-failure={failure.kind} className="space-y-4">
        <WorkflowHeader eyebrow="Library" title={copy.title} description={copy.lead} />
        <p className="max-w-3xl font-mono text-xs text-on-surface-variant" data-testid="library-review-error-detail">{failure.message}</p>
        <div className="flex flex-wrap gap-2">
          {failure.kind === "unavailable" && onRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="library-review-retry">Retry</Button>}
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>{failure.kind === "reselect" ? "Choose from Library" : "Back to Library"}</Button>
          <Button variant="outline" size="sm" onClick={back}>Back</Button>
        </div>
      </div>
    </WorkspacePage>
  );
}

interface ReviewContext {
  /** Exact origin of THIS review query (the useLibraryReview sourceHostId). */
  origin: string | null;
  readAt: number;
  stale: ReactNode;
}

function LibraryAgentReviewPage({ review, context }: { review: LibraryAgentReview; context: ReviewContext }) {
  const navigate = useNavigate();
  const back = useBack();
  const profiles = review.profiles ?? [];
  const resources = review.resources ?? { skills: [], guidance: [], plugins: [], subagents: [] };
  const { data: agentEntries } = useSpecLibrary("agent", { sourceHostId: context.origin });
  const rigCatalog = listRead(useSpecLibrary("rig", { sourceHostId: context.origin }), context.origin !== null);

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent" className="space-y-6">
        <WorkflowHeader
          eyebrow="Library — Agent Spec"
          title={review.name}
          description={review.description ?? "Agent spec from library."}
          actions={
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>Validate</Button>
              <Button variant="outline" size="sm" onClick={back} data-testid="library-review-back">Back</Button>
            </div>
          }
        />
        {context.stale}
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />
        <AuthoredSource origin={context.origin} sourcePath={review.sourcePath} readAt={context.readAt} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="AgentSpec" testId="lib-agent-format" />
          <WorkflowSummaryCard label="Version" value={review.version} testId="lib-agent-version" />
          <WorkflowSummaryCard label="Profiles" value={profiles.length} testId="lib-agent-profiles" />
          <WorkflowSummaryCard label="Skills" value={resources.skills.length} testId="lib-agent-skills" />
        </WorkflowSummaryGrid>

        <AgentSpecDisplay
          review={review}
          yaml={review.raw}
          testIdPrefix="lib-agent"
          sourcePath={review.sourcePath}
          originInstance={context.origin}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          <DeclaredByPanel hostId={context.origin} agent={{ name: review.name, sourcePath: review.sourcePath }} rigCatalog={rigCatalog} />
          <ObservedSeatsPanel hostId={context.origin} name={review.name} version={review.version} agentEntries={agentEntries} />
        </div>
      </div>
    </WorkspacePage>
  );
}

/** Each authored member reference, exactly as written, and what it resolves to
 * in this library. Unknown and non-`local:` refs are kept, not dropped. A
 * pending/unavailable agent list never reads as "no library entry". */
function MemberReferences({ review, origin, agentCatalog }: { review: LibraryRigReview; origin: string | null; agentCatalog: CatalogRead<SpecLibraryEntry> }) {
  const agentEntries = agentCatalog.entries ?? [];
  const lookupKnown = agentCatalog.state === "ok" || agentCatalog.state === "stale";
  const members = (review.pods ?? []).flatMap((pod) => pod.members.map((member) => ({ pod: pod.id, member })));
  if (members.length === 0) return null;
  return (
    <section data-testid="lib-member-refs" aria-label="Member agent references" className="border border-outline-variant/60">
      <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
        Member agent references (authored)
      </header>
      <ul className="divide-y divide-outline-variant/60">
        {members.map(({ pod, member }) => {
          const ref = resolveAuthoredAgentRef(review.sourcePath, member.agentRef, agentEntries);
          // Without a usable agent list only the authored form is known.
          const state = ref.state === "nonstandard" || lookupKnown ? ref.state : agentCatalog.state === "failed" ? "unavailable" : "pending";
          return (
            <li key={`${pod}\u0000${member.id}`} className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]" data-testid={`lib-member-ref-${pod}-${member.id}`} data-state={state}>
              <span className="font-mono font-bold text-on-surface">{pod}.{member.id}</span>
              <span className="min-w-0 break-words font-mono text-[11px] text-on-surface-variant">
                {member.agentRef} →{" "}
                {state === "pending" ? (
                  <span>checking the agent library…</span>
                ) : state === "unavailable" ? (
                  <span className="text-red-800">agent library unavailable ({agentCatalog.error?.message}); not resolved</span>
                ) : ref.state === "catalog" ? (
                  <LibraryEntryLink entryId={ref.entry.id} sourceHostId={origin ?? undefined} className="text-on-surface underline decoration-dotted">{ref.entry.name} v{ref.entry.version}</LibraryEntryLink>
                ) : ref.state === "uncatalogued" ? (
                  <span>{ref.path} (no library entry at this path{agentCatalog.state === "stale" ? ` in the list read ${readAge(agentCatalog.updatedAt)}; its refresh failed` : ""})</span>
                ) : (
                  <span>not a local file reference; resolved at launch, not in this library view</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LibraryRigReviewContent({ review, context }: { review: LibraryRigReview; context: ReviewContext }) {
  const navigate = useNavigate();
  const back = useBack();
  const [setupPromptCopied, setSetupPromptCopied] = useState(false);
  const agentCatalog = listRead(useSpecLibrary("agent", { sourceHostId: context.origin }), context.origin !== null);
  const agentEntries = agentCatalog.entries ?? [];
  const reviewPods = review.pods ?? [];
  const reviewNodes = review.nodes ?? [];
  const reviewEdges = review.edges ?? [];

  // Exact authored resolution only: a sourcePath prefix or same name is not
  // the file this member declares.
  const resolveMemberAgent = (agentRef: string) => {
    const ref = resolveAuthoredAgentRef(review.sourcePath, agentRef, agentEntries);
    return ref.state === "catalog" ? ref.entry : null;
  };
  const openAgent = useLibraryEntryNavigate(context.origin);

  return (
    <WorkspacePage>
      <div data-testid="library-review-rig" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.services ? "Library — Managed App" : "Library — Rig Spec"}
          title={review.name}
          description={review.summary ?? "Rig spec from library."}
          actions={
            <div className="flex gap-2">
              {review.services && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="copy-setup-prompt"
                  onClick={() => void (async () => {
                    const copied = await copyText(buildSetupPrompt({
                      name: review.name,
                      summary: review.summary,
                      sourcePath: review.sourcePath,
                    }));
                    if (!copied) return;
                    setSetupPromptCopied(true);
                    window.setTimeout(() => setSetupPromptCopied(false), 2000);
                  })()}
                >
                  {setupPromptCopied ? "Copied" : "Copy Setup Prompt"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>Import</Button>
              <Button variant="outline" size="sm" onClick={back} data-testid="library-review-back">Back</Button>
            </div>
          }
        />
        {context.stale}
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />
        <AuthoredSource origin={context.origin} sourcePath={review.sourcePath} readAt={context.readAt} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value={review.format === "pod_aware" ? "Pod-Aware" : "Legacy"} testId="lib-rig-format" />
          {review.services && (
            <WorkflowSummaryCard label="Type" value="Agent-Managed App" testId="lib-rig-type" />
          )}
          {review.services && reviewPods.length > 0 && (() => {
            const specialistPod = reviewPods.find((p) => p.members.some((m) => m.id === "specialist"));
            if (!specialistPod) return null;
            return (
              <WorkflowSummaryCard
                label="Specialist Agent"
                value={`${specialistPod.id}.specialist`}
                testId="lib-rig-specialist"
              />
            );
          })()}
          <WorkflowSummaryCard
            label={review.format === "pod_aware" ? "Pods" : "Nodes"}
            value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
            testId="lib-rig-pods"
          />
          <WorkflowSummaryCard
            label="Members"
            value={review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
              : reviewNodes.length}
            testId="lib-rig-members"
          />
          <WorkflowSummaryCard
            label="Edges"
            value={reviewEdges.length + (review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
              : 0)}
            testId="lib-rig-edges"
          />
        </WorkflowSummaryGrid>

        <RigSpecDisplay
          review={review}
          yaml={review.raw}
          testIdPrefix="lib"
          yamlTestId="lib-rig-yaml"
          showEnvironmentTab={!!review.services}
          onMemberClick={(podId, member) => {
            const agentEntry = resolveMemberAgent(member.agentRef);
            if (agentEntry) openAgent(agentEntry.id);
          }}
        />
        <MemberReferences review={review} origin={context.origin} agentCatalog={agentCatalog} />
      </div>
    </WorkspacePage>
  );
}

export function LibraryReview({ entryId, sourceHostId }: LibraryReviewProps) {
  // PL-014: context_packs live at /api/context-packs/library and have
  // an id prefix of "context-pack:". Dispatch to the pack-specific
  // review page before invoking useLibraryReview (which would 404
  // against the spec-library route for context-pack ids).
  if (entryId.startsWith("context-pack:")) {
    return <LibraryContextPackReviewPage entryId={entryId} />;
  }
  // PL-016: agent_images live at /api/agent-images/library with id
  // prefix "agent-image:".
  if (entryId.startsWith("agent-image:")) {
    return <LibraryAgentImageReviewPage entryId={entryId} />;
  }
  return <LibrarySpecReview entryId={entryId} sourceHostId={sourceHostId} />;
}

function LibrarySpecReview({ entryId, sourceHostId }: LibraryReviewProps) {
  const reviewed = <LibrarySpecReviewBody entryId={entryId} sourceHostId={sourceHostId} />;
  return sourceHostId === undefined
    ? <><PresumedOrigin />{reviewed}</>
    : <><ReviewOrigin sourceHostId={sourceHostId} />{reviewed}</>;
}

/** Selected-host default before the host read lands: the read went to the
 * connected instance by presumption — say so instead of implying a choice. */
function PresumedOrigin() {
  const hosts = useHostSelectionState();
  if (hosts.state === "known") return null;
  return (
    <div data-testid="library-review-origin-presumed" className="px-4 pt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-800">
      Host selection {hosts.state === "failed" ? "unavailable" : "not yet known"} — read from the connected instance
    </div>
  );
}

function LibrarySpecReviewBody({ entryId, sourceHostId }: LibraryReviewProps) {
  const query = useLibraryReview(entryId, sourceHostId === undefined ? {} : { sourceHostId });
  const { data: review, isLoading, error, sourceHostId: readOrigin } = query;

  if (readOrigin === null) return <UnknownSource />;

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">Loading spec review...</div>
      </WorkspacePage>
    );
  }

  if (!review) {
    return <ReadFailure failure={error ? classifyLibraryReadError(error) : { kind: "unavailable", message: "Could not load spec." }} onRetry={() => void query.refetch()} />;
  }

  const context: ReviewContext = {
    origin: readOrigin,
    readAt: query.dataUpdatedAt,
    stale: error ? <StaleReview error={error} readAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} /> : null,
  };
  // Keyed by exact entry + origin so per-review action state never carries
  // over to another review rendered in the same position.
  const key = `${review.libraryEntryId}\u0000${readOrigin}`;

  if (review.kind === "agent") {
    return <LibraryAgentReviewPage key={key} review={review as LibraryAgentReview} context={context} />;
  }

  if (review.kind === "workflow") {
    return <LibraryWorkflowReviewPage key={key} review={review as LibraryWorkflowReview} context={context} />;
  }

  return <LibraryRigReviewContent key={key} review={review as LibraryRigReview} context={context} />;
}

function UnknownSource() {
  const navigate = useNavigate();
  return (
    <WorkspacePage>
      <div data-testid="library-review-source-unknown" className="space-y-4">
        <WorkflowHeader eyebrow="Library" title="Spec source unknown" description="This link does not name a known library origin, so nothing was read. Open the spec again from its page." />
        <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Library</Button>
      </div>
    </WorkspacePage>
  );
}

// --- Workflows in Spec Library v0: workflow review variant ---

/** The active lens is the CONNECTED instance's preference. Writes go through
 * useActiveLensActions, which rechecks at invocation that the current known
 * selection and this review's own origin are both local. */
function lensAdmission(origin: string | null, hosts: ReturnType<typeof useHostSelectionState>): string | null {
  if (origin !== "local") return `This review was read from ${originLabel(origin)}. The active lens belongs to the connected instance, so it can only be set from a connected-instance review.`;
  if (hosts.state !== "known") return "The host selection is not known yet; the lens can be changed once it is.";
  if (hosts.selected !== "local") return `Host ${hosts.selected} is selected. Select the local host to change the connected instance's lens.`;
  return null;
}

/** The connected lens as READ: a valid served null is known absence; pending
 * or failed without data is unknown; a failed refresh keeps dated evidence. */
function ActiveLensReadState({ local, query }: { local: boolean; query: ReturnType<typeof useActiveLens> }) {
  if (!local) return <div data-testid="workflow-lens-read" data-state="not-applicable">Reviewing this spec does not change any lens.</div>;
  const lens = query.data;
  const describe = (value: typeof lens) => (value ? `${value.specName} v${value.specVersion}` : "no active lens");
  const message = query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "";
  if (lens === undefined) {
    return query.error
      ? <div role="alert" data-testid="workflow-lens-read" data-state="unavailable" className="text-red-800">The connected instance's lens is unavailable: {message}</div>
      : <div data-testid="workflow-lens-read" data-state="pending">Reading the connected instance's lens…</div>;
  }
  if (query.error) {
    return (
      <div role="status" data-testid="workflow-lens-read" data-state="stale" className="text-amber-800">
        Read {readAge(query.dataUpdatedAt)}: {describe(lens)}. The latest refresh failed ({message}), so this may no longer be current.
      </div>
    );
  }
  return (
    <div data-testid="workflow-lens-read" data-state="current">
      {lens ? `The connected instance's lens is ${describe(lens)}.` : "The connected instance has no active lens."}
    </div>
  );
}

function LibraryWorkflowReviewPage({ review, context }: { review: LibraryWorkflowReview; context: ReviewContext }) {
  const back = useBack();
  const lensQuery = useActiveLens();
  const activeLens = lensQuery.data;
  const { setActiveLens, clearActiveLens } = useActiveLensActions();
  const hosts = useHostSelectionState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = lensAdmission(context.origin, hosts);
  // Only a connected-instance review can describe the connected lens.
  const isThisLensActive = context.origin === "local" && activeLens?.specName === review.name && activeLens?.specVersion === review.version;

  // Both callers bind the origin of the review query that produced this page;
  // the hook owns the existing active-lens + slices invalidations.
  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      await setActiveLens({ originHostId: context.origin, specName: review.name, specVersion: review.version });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearActiveLens({ originHostId: context.origin });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };


  return (
    <WorkspacePage>
      <div data-testid="library-review-workflow" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.isBuiltIn ? "Library — Workflow (Built-in)" : "Library — Workflow"}
          title={`${review.name} v${review.version}`}
          description={review.purpose ?? "Workflow spec from library."}
          actions={
            <div className="flex gap-2 items-center">
              {isThisLensActive ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-deactivate-lens"
                  onClick={() => void deactivate()}
                  disabled={busy || blocked !== null}
                  title={blocked ?? undefined}
                >
                  {busy ? "..." : "Deactivate Lens"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-activate-lens"
                  onClick={() => void activate()}
                  disabled={busy || blocked !== null}
                  title={blocked ?? undefined}
                >
                  {busy ? "..." : "Activate as Lens"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={back} data-testid="library-review-back">Back</Button>
            </div>
          }
        />
        {context.stale}
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState="library_item" />
        <AuthoredSource origin={context.origin} sourcePath={review.sourcePath} readAt={context.readAt} cached={review.cachedAt} />
        <div data-testid="workflow-lens-scope" className="border-l-2 border-secondary/60 pl-3 text-xs leading-relaxed text-on-surface-variant">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface">Active lens · connected-instance preference</span>
          <ActiveLensReadState local={context.origin === "local"} query={lensQuery} />
          {blocked && <div data-testid="workflow-lens-blocked" className="text-amber-800">{blocked}</div>}
        </div>
        {error && <div role="alert" data-testid="workflow-lens-error" className="font-mono text-[10px] text-red-600">{error}</div>}

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Format" value="WorkflowSpec" testId="lib-wf-format" />
          <WorkflowSummaryCard label="Version" value={review.version} testId="lib-wf-version" />
          <WorkflowSummaryCard label="Roles" value={review.rolesCount} testId="lib-wf-roles" />
          <WorkflowSummaryCard label="Steps" value={review.stepsCount} testId="lib-wf-steps" />
          <WorkflowSummaryCard label="Target Rig" value={review.targetRig ?? "(any)"} testId="lib-wf-target-rig" />
          <WorkflowSummaryCard label="Source" value={review.isBuiltIn ? "built-in" : "user file"} testId="lib-wf-source" />
        </WorkflowSummaryGrid>

        <div data-testid="workflow-terminal-rule" className="flex items-center gap-2 border border-outline-variant/40 bg-surface-lowest/10 px-3 py-2 font-mono text-[10px] text-on-surface">
          <ToolMark tool="terminal" size="xs" decorative />
          <span className="text-on-surface-variant uppercase tracking-[0.16em] text-[8px]">Coordination Terminal Turn:</span>
          {review.terminalTurnRule}
        </div>

        <WorkflowTopologyGraph topology={review.topology} />

        {/* OPR.0.4.6.WF4 (C4) — the A-lite "runs of THIS spec" instances band.
            quietWhenEmpty: renders NOTHING at zero instances, so a spec with no
            live runs is byte-identical to the shipped Library page (zero-regression). */}
        <WorkflowInstancesBand workflowName={review.name} workflowVersion={review.version} testId="library-instances-band" />

        <div className="space-y-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">Steps</div>
          <div className="space-y-1">
            {review.steps.map((step) => (
              <div
                key={step.stepId}
                data-testid={`workflow-step-${step.stepId}`}
                className="border border-outline-variant/40 bg-surface-lowest/5 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-on-surface">{step.stepId}</span>
                  <span className="font-mono text-[9px] text-on-surface-variant">{step.role}</span>
                </div>
                {step.objective && <div className="mt-1 text-[10px] text-on-surface-variant leading-tight">{step.objective}</div>}
                {step.allowedNextSteps.length > 0 && (
                  <div className="mt-1 font-mono text-[9px] text-on-surface-variant">
                    next: {step.allowedNextSteps.map((n) => `${n.stepId} (${n.role})`).join(", ")}
                  </div>
                )}
                {step.allowedExits.length > 0 && (
                  <div className="font-mono text-[9px] text-on-surface-variant">
                    exits: {step.allowedExits.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}

// --- Rig Context / Composable Context Injection v0 (PL-014):
//     context_pack review page ---

function LibraryContextPackReviewPage({ entryId }: { entryId: string }) {
  const packs = useContextPackLibrary();
  const entry = packs.data?.find((p) => p.id === entryId) ?? null;
  // Atom 5: preview addresses by the pack's path-like ref, not its opaque id.
  const preview = useContextPackPreview(entry ? entry.relativePath : null);

  if (packs.isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">Loading context pack…</div>
      </WorkspacePage>
    );
  }
  if (!entry) {
    // A failed list read is not absence; absence is only a successful list
    // without this exact ID.
    return (
      <ReadFailure
        failure={packs.data === undefined
          ? { kind: "unavailable", message: packs.error instanceof Error ? packs.error.message : "The context-pack library could not be read." }
          : { kind: "absent", message: `The connected instance's context-pack list (read ${readAge(packs.dataUpdatedAt)}) has no pack with ID ${entryId}.` }}
        onRetry={() => void packs.refetch()}
        subject="Context Pack"
      />
    );
  }

  return (
    <ContextPackReviewBody
      entry={entry}
      listRead={{ at: packs.dataUpdatedAt, error: packs.error, retry: () => void packs.refetch() }}
      preview={preview}
    />
  );
}

interface ListRead { at: number; error: unknown; retry: () => void }

/** The list row and its preview are separate reads with separate failures. */
function PreviewState({ query, testId, label }: { query: { data?: unknown; error: unknown; isLoading: boolean; dataUpdatedAt: number; refetch: () => unknown }; testId: string; label: string }) {
  if (query.isLoading) return <div className="px-3 py-2 font-mono text-[9px] text-on-surface-variant">Loading {label}…</div>;
  const message = query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "";
  if (query.error) {
    return (
      <div role={query.data === undefined ? "alert" : "status"} data-testid={testId} className={`px-3 py-2 text-xs ${query.data === undefined ? "text-red-800" : "text-amber-800"}`}>
        {query.data === undefined ? `${label} unavailable: ${message}` : `Refreshing the ${label} failed (${message}); showing the copy read ${readAge(query.dataUpdatedAt)}.`}{" "}
        <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button>
      </div>
    );
  }
  if (query.data !== undefined) return <div className="px-3 pt-2 font-mono text-[9px] text-on-surface-variant">{label} read {readAge(query.dataUpdatedAt)}</div>;
  return null;
}

function ListStale({ read }: { read: ListRead }) {
  if (!read.error) return null;
  return <StaleReview error={read.error} readAt={read.at} onRetry={read.retry} />;
}

function ContextPackReviewBody({
  entry,
  listRead,
  preview: previewQuery,
}: {
  entry: ContextPackEntry;
  listRead: ListRead;
  preview: ReturnType<typeof useContextPackPreview>;
}) {
  const navigate = useNavigate();
  const back = useBack();
  const preview = previewQuery.data;

  return (
    <WorkspacePage>
      <div data-testid="library-review-context-pack" className="space-y-4">
        <WorkflowHeader
          eyebrow={`Library — Context Pack${entry.sourceType === "builtin" ? " (built-in)" : ""}`}
          title={entry.name}
          description={entry.purpose ?? "Operator-authored composable context bundle."}
          actions={
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Library</Button>
              <Button variant="outline" size="sm" onClick={back} data-testid="library-review-back">Back</Button>
            </div>
          }
        />
        <ListStale read={listRead} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Version" value={entry.version} testId="lib-pack-version" />
          <WorkflowSummaryCard label="Files" value={entry.files.length} testId="lib-pack-files" />
          <WorkflowSummaryCard
            label="Tokens (~)"
            value={String(entry.derivedEstimatedTokens)}
            testId="lib-pack-tokens"
          />
          <WorkflowSummaryCard label="Source" value={entry.sourceType} testId="lib-pack-source" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-pack-source-path" className="font-mono text-[9px] text-on-surface-variant">
          path: {entry.sourcePath} · listed by the connected instance {readAge(listRead.at)}
        </div>

        <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
          <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
            Files
          </header>
          <ul data-testid="lib-pack-file-list" className="divide-y divide-outline-variant">
            {entry.files.map((f) => {
              const missing = f.bytes === null;
              return (
                <li
                  key={f.path}
                  data-testid={`lib-pack-file-${f.path}`}
                  data-missing={missing ? "true" : "false"}
                  className={`font-mono text-[10px] ${missing ? "text-red-700" : "text-on-surface"}`}
                >
                  <FileReferenceTrigger
                    data={{ path: f.path, absolutePath: f.absolutePath, originInstance: "local" }}
                    testId={`lib-pack-file-trigger-${f.path}`}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-low/60 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold truncate underline decoration-dotted decoration-outline">{f.path}</span>
                      <span className="font-mono text-[8px] text-on-surface-variant shrink-0">
                        role: {f.role}
                        {missing
                          ? " · MISSING"
                          : ` · ${f.bytes}B · ~${f.estimatedTokens} tokens`}
                      </span>
                    </div>
                    {f.summary && (
                      <div className="mt-0.5 text-on-surface-variant text-[9px]">{f.summary}</div>
                    )}
                  </FileReferenceTrigger>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
          <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
            Bundle preview
          </header>
          <PreviewState query={previewQuery} testId="lib-pack-preview-error" label="bundle preview" />
          {preview && (
            <>
              {preview.missingFiles.length > 0 && (
                <div data-testid="lib-pack-missing-warning" className="px-3 py-2 font-mono text-[9px] text-red-700 border-b border-outline-variant">
                  Warning: {preview.missingFiles.length} file{preview.missingFiles.length === 1 ? "" : "s"} referenced by manifest but missing on disk.
                </div>
              )}
              <pre
                data-testid="lib-pack-bundle-text"
                className="font-mono text-[9px] text-on-surface bg-background px-3 py-2 max-h-96 overflow-y-auto whitespace-pre-wrap"
              >
                {preview.bundleText}
              </pre>
            </>
          )}
        </section>
      </div>
    </WorkspacePage>
  );
}

// --- Fork Primitive + Starter Agent Images v0 (PL-016): agent-image
//     review variant. Shows manifest + statistics badges + lineage +
//     Use-as-starter snippet + Pin/Unpin button. ---

function LibraryAgentImageReviewPage({ entryId }: { entryId: string }) {
  const images = useAgentImageLibrary();
  const entry = images.data?.find((i) => i.id === entryId) ?? null;
  const preview = useAgentImagePreview(entry ? entryId : null);

  if (images.isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">Loading agent image…</div>
      </WorkspacePage>
    );
  }
  if (!entry) {
    return (
      <ReadFailure
        failure={images.data === undefined
          ? { kind: "unavailable", message: images.error instanceof Error ? images.error.message : "The agent-image library could not be read." }
          : { kind: "absent", message: `The connected instance's agent-image list (read ${readAge(images.dataUpdatedAt)}) has no image with ID ${entryId}. Image IDs for names or versions containing ":" changed; an older link must be reselected from the Library.` }}
        onRetry={() => void images.refetch()}
        subject="Agent Image"
      />
    );
  }
  return (
    <AgentImageReviewBody
      entry={entry}
      listRead={{ at: images.dataUpdatedAt, error: images.error, retry: () => void images.refetch() }}
      preview={preview}
    />
  );
}

function AgentImageReviewBody({
  entry,
  listRead,
  preview: previewQuery,
}: {
  entry: AgentImageEntry;
  listRead: ListRead;
  preview: ReturnType<typeof useAgentImagePreview>;
}) {
  const navigate = useNavigate();
  const back = useBack();
  const preview: AgentImagePreview | undefined = previewQuery.data;
  const pinMutation = useAgentImagePin();
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const onCopySnippet = async () => {
    if (!preview?.starterSnippet) return;
    const ok = await copyText(preview.starterSnippet);
    if (ok) {
      setSnippetCopied(true);
      window.setTimeout(() => setSnippetCopied(false), 2000);
    }
  };

  const onTogglePin = async () => {
    setPinError(null);
    try {
      await pinMutation.mutateAsync({ id: entry.id, pin: !entry.pinned });
    } catch (err) {
      setPinError((err as Error).message);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent-image" className="space-y-4">
        <WorkflowHeader
          eyebrow={`Library — Agent Image${entry.sourceType === "builtin" ? " (built-in)" : ""}`}
          title={`${entry.name} v${entry.version}`}
          description={entry.notes ?? `Snapshot of ${entry.sourceSeat}.`}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="agent-image-pin-toggle"
                onClick={() => void onTogglePin()}
                disabled={pinMutation.isPending}
              >
                {entry.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>Back to Library</Button>
              <Button variant="outline" size="sm" onClick={back} data-testid="library-review-back">Back</Button>
            </div>
          }
        />
        <ListStale read={listRead} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard
            label="Runtime"
            value={<RuntimeBadge runtime={entry.runtime} size="sm" compact variant="inline" />}
            testId="lib-image-runtime"
          />
          <WorkflowSummaryCard label="Forks" value={String(entry.stats.forkCount)} testId="lib-image-forks" />
          <WorkflowSummaryCard label="Tokens (~)" value={String(entry.derivedEstimatedTokens)} testId="lib-image-tokens" />
          <WorkflowSummaryCard label="Size" value={`${entry.stats.estimatedSizeBytes}B`} testId="lib-image-size" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-image-source" className="font-mono text-[9px] text-on-surface-variant space-y-0.5">
          <div>source seat: {entry.sourceSeat}</div>
          {/* Surface source_cwd so operators see
            * WHERE the parent session was created. Older
            * manifests render "(unknown)" honestly. */}
          <div data-testid="lib-image-source-cwd">source cwd: {entry.sourceCwd ?? "(unknown — pre-Finding-2 manifest)"}</div>
          <div>created: {entry.createdAt}</div>
          <div>last used: {entry.stats.lastUsedAt ?? "never"}</div>
          <div>path: {entry.sourcePath}</div>
          <div data-testid="lib-image-pinned" className={entry.pinned ? "text-amber-700 font-bold" : ""}>pinned: {String(entry.pinned)}</div>
        </div>

        {entry.lineage.length > 0 && (
          <section data-testid="lib-image-lineage" className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
            <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
              Lineage
            </header>
            <div className="px-3 py-2 font-mono text-[10px] text-on-surface">
              {entry.lineage.join(" → ")} → <span className="font-bold">{entry.name}</span>
            </div>
          </section>
        )}

        <ForkNowAction entry={entry} />

        <section data-testid="lib-image-starter-snippet" className="border border-outline bg-surface-lowest px-3 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface">Use as starter</div>
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-image-copy-snippet"
              onClick={() => void onCopySnippet()}
              disabled={!preview?.starterSnippet}
            >
              {snippetCopied ? "Copied" : "Copy snippet"}
            </Button>
          </div>
          <div className="font-mono text-[9px] text-on-surface-variant">
            Paste into your agent.yaml's session_source. The instantiator resolves the image
            via the daemon AgentImageLibraryService at startup time.
          </div>
          <PreviewState query={previewQuery} testId="lib-image-preview-error" label="starter snippet" />
          {preview?.starterSnippet && (
            <pre
              data-testid="lib-image-snippet-text"
              className="font-mono text-[10px] bg-background border border-outline-variant px-2 py-1 whitespace-pre-wrap"
            >
              {preview.starterSnippet}
            </pre>
          )}
        </section>

        {pinError && (
          <div data-testid="lib-image-pin-error" className="font-mono text-[9px] text-red-600">{pinError}</div>
        )}

        {entry.files.length > 0 && (
          <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
            <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
              Supplementary files
            </header>
            <ul className="divide-y divide-outline-variant">
              {entry.files.map((f) => (
                <li
                  key={f.path}
                  className="font-mono text-[10px] text-on-surface"
                  data-testid={`lib-image-file-${f.path}`}
                >
                  <FileReferenceTrigger
                    data={{ path: f.path, absolutePath: f.absolutePath, originInstance: "local" }}
                    testId={`lib-image-file-trigger-${f.path}`}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-low/60 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold truncate underline decoration-dotted decoration-outline">{f.path}</span>
                      <span className="font-mono text-[8px] text-on-surface-variant shrink-0">
                        role: {f.role}
                        {f.bytes === null ? " · MISSING" : ` · ${f.bytes}B`}
                      </span>
                    </div>
                    {f.summary && <div className="mt-0.5 text-on-surface-variant text-[9px]">{f.summary}</div>}
                  </FileReferenceTrigger>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </WorkspacePage>
  );
}
