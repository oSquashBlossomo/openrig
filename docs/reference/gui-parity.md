# TUI → web operator capability audit

Audited 2026-10-04 against checkout base `bbbeee6214fe0e0b89c622573e3bb132e360395d`. This is a source audit, not a claim of browser or native-runtime verification. The gaps below describe the source snapshot inspected for this audit. No installed daemon, agents, tmux sessions, native histories, or global settings were operated.

The inventory follows the eight entries in `packages/tui/src/sections.ts`, the complete command registry in `packages/tui/src/commands/registry.ts`, and the startup/recovery surfaces outside that registry. It distinguishes data/operational parity from terminal presentation. Browser scroll, selection, history, responsive layout and accessible buttons can satisfy terminal interaction requirements without copying escape sequences or tmux behavior.

`ARCHITECTURE.md` describes the upstream UI as maintenance-only. This reference supports GUI modernization in this fork. Existing daemon contracts remain the source of truth; a visually richer surface must not turn unknown evidence into success, treat receipts as acceptance, or perform writes while browsing.

## Implementation checkpoints

The findings below preserve the audited baseline. This section records subsequent
verified changes without implying that the rest of the matrix is complete.

- **Shared daemon health:** `SettingsSystemStatusPanel` now uses the common typed
  health query and shows event-loop-unhealthy evidence. Five regression cases in
  `packages/ui/test/settings-system-status-health.test.tsx` pass, including offset
  polling after navigation and preservation of the shared terminal health signal.
- **Canonical read contracts:** Health, Attention, delivered human updates,
  Configuration, Connections and Slack manifest hooks now preserve their complete
  served projections and exact instance/entity query keys. Remote forwarding is
  explicitly unsupported for these APIs. Five-second deadlines cover headers and
  body parsing; cancellation and malformed responses are distinct errors. The
  common daemon-health poll also uses this deadline, so a hung read replaces a
  previous healthy verdict with an unavailable signal. Four focused suites pass
  (51 tests), and UI typecheck passes. These are transport and contract checks;
  user-facing pages and their browser verification are still in progress.
- **Terminal preview and Open:** `TerminalLauncher` uses `useTerminalPreview` for
  readiness, provider availability, pages, geometry and unavailable-seat reasons.
  Open submits the exact preview plan. Twenty-seven launcher tests pass, including
  stale-plan refresh, saved-name collisions, unknown deep links and host changes.
  These are HTTP-boundary UI tests; native terminal opening and shared-pane sizing
  require separate integration evidence.
- **Shared terminal geometry:** Protocol 2 transmits the native pane dimensions
  before terminal output; opening or resizing a browser no longer changes the
  tmux window size or sizing policy. Private tmux/WebSocket tests verify pane
  identity, two viewers sharing one pipe, native resize propagation and cleanup.
  Seventy daemon tests and 34 focused UI tests pass. Independent review reproduced
  and then verified the repair of a resize/output race. Busy output can defer a
  screen repaint until a quiet boundary, while raw output continues streaming.
  Clients must reload across this protocol change; older raw-stream clients get
  explicit update/reload guidance. Actual native Claude/Codex rendering remains
  part of browser integration verification.
- **Exact project reads:** Catalog, scopes, execution and slice readers now retain
  project ID and canonical root in requests and cache keys. Selected-project
  document routes reuse the same catalog/mission resolver and reject symlink
  escapes. A selected project without a proof-packet source returns unavailable
  instead of serving a same-named packet from the default workspace. Twenty-seven
  UI contract tests and 41 daemon route tests pass; actual daemon responses also
  pass the browser guards. Project pages still require frontend integration.
- **Workflow recovery contracts:** Reads now retain aborted status, packets,
  failure occurrences, source reconciliation and receipt facts. New mutations
  retain exact failure identity and immutable recovery attempts without automatic
  retries. An unknown explicit failure ID cannot resume a different failure.
  HTTP 500 after a committed resume remains an unknown outcome requiring observed
  readback. Independent real-route reproductions verify both corrections; focused
  suites pass 45 daemon and 62 UI tests. The existing page's Resume control still
  requires migration to the occurrence chooser and new mutation helper.
- **Workflow abort contract:** The new helper retains exact actor/reason bytes,
  performs one submission and preserves uncertain outcomes for readback. A known
  missing frontier packet is reported as rejected only for the documented abort
  HTTP 404 response; its transaction rolls back earlier packet closures. Actual
  Hono/SQLite checks verify success, rollback and post-commit notification failure.
  Thirty-eight focused abort/resume/revision/scope tests pass. Frontend controls
  remain unfinished and are not covered by this transport checkpoint.
- **Topology data reliability:** Shared 2D/3D summary and graph requests have
  cancellable five-second deadlines. Invalid payload containers fail visibly;
  nullable names retain the existing partial-inventory fallback. The spatial
  model tracks actual cache data, so two updates in one millisecond do not leave
  it stale. Sample age uses the sample timestamp, with unknown age for terminal
  output fallback. Renderer presentation and interaction acceptance remain open.
- **Real browser terminal checkpoint:** Actual xterm, WebSocket broker and a
  private tmux session were exercised with two viewers, Unicode output, input,
  native resize, independent history scrolling and disconnect cleanup. Browser
  resize preserved native pane size, process identity and sizing policy. This
  used a harmless scripted writer, not native Claude/Codex. Fitted interactive
  text is still too small at phone width and needs a readable presentation.
- **Startup and fleet restore contracts:** Exact seat/runtime/revision selections
  and fresh-start consent remain bound to the inspected state. One mutation lane
  preserves the first attempt across duplicate clicks; uncertain replies retain
  identity for inspection rather than automatically replaying effects. Accepted
  fleet handles survive view unmount and reload, with storage failure reported
  separately. Detaching observation does not cancel accepted work. Forty-six
  focused tests pass, with independent duplicate-click and actual daemon-route
  checks. Startup and fleet receipt screens still require frontend integration.
- **Durable Recent and Pulse reads:** Served transition windows and exact selected
  rows no longer depend on the ephemeral event feed. Pulse preserves independently
  available queue and pane sources, unknown totals, bounded enrichment and partial
  failures. Unresolved blocker ownership cannot become an exact count; active pane
  evidence remains visible when queue sources fail. Fifty-nine focused checks and
  two independent reproductions pass. User-facing consumers and event invalidation
  remain to be integrated.
- **Terminal catalog read boundaries:** Catalog and preview reads now have total
  five-second deadlines, cancellation and payload guards. Unknown host selection
  waits for actual authority; unsupported remote selection and manual refetch
  cannot fall back to local data. Exact view/provider/plan identity survives cache
  transitions. One hundred focused tests pass, including the unchanged launcher;
  independent actual daemon-route and cancellation cases also pass. A standalone
  terminal catalog destination remains a frontend gap.
- **File replacement safety:** The editor cannot save truncated or binary
  previews as whole-file replacements. It checks complete text metadata, retains
  the draft's original change-detection tokens and rechecks the latest cached
  snapshot before Save. Thirty-one focused tests and seven independent private
  cases pass, including actual Files UI/Hono write behavior. Complete LF UTF-8
  editing remains supported. CR/CRLF editing is currently read-only until its
  line endings can be preserved; source/host identity and richer file navigation
  remain open requirements.
- **Node and library read identity:** Seat detail, spec listings and opaque-ID
  reviews no longer show a previous entity or host while the new selection loads.
  Reads have cancellable five-second deadlines and validate exact returned IDs;
  supported remote requests keep the daemon's read-through envelope. Original
  nullable, diagnostic and source-provenance fields remain intact. One hundred
  thirteen focused tests and an independent actual-source check pass. Consumers
  still need consistent stale/error presentation and correct source destinations.
- **Host selection read boundary:** Host reads now validate the actual selection
  and transport-specific endpoint fields, use one cancellable five-second budget,
  and retain removed aliases without substituting local authority. Fifty-eight
  hook/downstream tests and one actual daemon-route test pass; independent review
  also verifies the missing-endpoint refusals. Existing cached selection semantics
  remain unchanged, so consumers must disclose failed refreshes separately.
- **Canonical live refreshes:** Health and Attention event bursts no longer
  restart an in-flight bounded read. Reconnect and narrower event families
  coalesce into one follow-up per affected query after it settles. Startup and
  related health events also refresh Health-derived Attention. Fifty focused
  tests and the original independent slow-read reproduction pass. Legacy
  topology/process/project event families are still being investigated separately.
- **Spatial browser checkpoint:** The actual application, with fictional API data,
  now fits a 526×448 canvas inside an unchanged 1280×720 browser viewport. Seat
  selection, focus, evidence, relationships, search and List mode were exercised.
  A 412-seat fixture retains the final seat in searchable list/detail fallback;
  an unavailable rig leaves an explicit partial-source warning and usable sibling
  rigs. Empty and malformed inventories show distinct states. Independent camera
  tests verify that a Reset animation cannot overwrite newer automatic framing.
  Rejected renderer imports now receive a fresh loader on Retry; constructor
  retries reuse downloaded code. Sixty-two focused tests and independent
  concurrent-mount checks pass. Additional viewport sizes and complete integration
  remain open; this checkpoint does not establish full spatial acceptance.
- **Current integrated UI checkpoint:** 214 files passed (1,963 tests, one
  existing skip) after the contract/data changes and compatible dependency
  refresh. Workspace build and typechecks pass. This local run includes the
  unfinished spatial renderer; its known visual/interaction corrections remain
  required before feature acceptance.
- **Initial local baseline:** 198 UI test files passed (1,729 tests, one existing
  skip). Build passed. The first full package run exposed 14 daemon and one CLI
  test-fixture failures involving macOS path aliases and an ambient daemon state
  file. The four affected suites pass after isolating their fixture roots (128
  tests). Full integrated validation remains required as implementation continues.

## Priority findings

| Priority | Finding and concrete consequence | Source evidence | Required acceptance |
| --- | --- | --- | --- |
| P0 | Two incompatible `/healthz` query functions share `["daemon","health"]`. Visiting Settings → Status can replace the payload used by the globally mounted health provider with a boolean, losing event-loop evidence. The status panel also calls any successful response “OK” even with `eventLoop.healthy=false`. | `ui/src/components/system/SettingsSystemStatusPanel.tsx` `fetchHealth` returns `true`; `ui/src/hooks/useDaemonHealth.ts` returns `DaemonHealthPayload` under the same key; provider is mounted by `ui/src/routes.tsx`. | One typed health query; stalled/error/loading states remain distinct; event-loop-unhealthy HTTP 200 is shown as unhealthy and remains visible to terminal consumers after route navigation. |
| P1 | Canonical instance/rig/seat health findings, explanation, typed evidence, freshness, indeterminate state and detector coverage are absent from the GUI. `/healthz` and old `/health-summary/*` do not substitute for `/api/health`. | No `/api/health` consumer in baseline `ui/src`; TUI `health/health-model.ts` and `hydrate.ts` consume canonical findings. Daemon mounts both old summaries and new health routes independently. | Canonical findings at System and scoped topology; typed details and partial coverage; empty means no findings served, not “healthy.” |
| P1 | Unified human requests/outcome/health feed is absent. GUI attention reads queue attention and ephemeral events; native proof judgments, manifest-bound lifecycle outcome receipts, canonical health updates, and delivered human updates are not covered. | `ui/src/hooks/useAttentionItems.ts` reads `/api/queue/list?attention=1` or aggregate; no `/api/attention` or `/api/queue/human-updates` consumer. TUI `attention/attention-model.ts` composes both. | Split action/update lenses; source availability; recipient and what a request unblocks; retained detail after closure; correlated Slack decision guidance. |
| P1 | Project is effectively a configured workspace/indexer in the GUI, not an exact catalog selection. Duplicate mission/slice names in multiple catalog projects cannot be safely addressed through current routes/queries. | TUI `projects`, `project <id>` and `projectQuery` send `project` plus `projectRoot`; no GUI `/api/scopes/projects` consumer, and `useMission`/`useSlices` omit project identity. | Exact catalog picker; project ID/root retained in query keys, links, sources, mission and slice requests; reject moved/stale/unknown roots rather than silently reading another project. |
| P1 | GUI mission/slice progress still emphasizes checkbox/proof-packet counts; it does not expose the TUI execution story, current attributed judgments, per-rung basis, bound workflow packets and reconciliation. Existing readiness chips are only partial parity. | No GUI `/api/views/execution` or `/api/scopes` consumer; `project/ScopePages.tsx` slice readiness uses `acceptance` counts and `tests.aggregate`; `scopes/scopes-model.ts` and `execution/execution-model.ts` use canonical readiness and execution. | Preserve declared status, native outcomes, publication, lifecycle completion and legacy code evidence as distinct facts; inspect actor/reason/revision/hash for acceptance. |
| P1 | Terminal launcher preview invents readiness from session names and marks all saved members live. It guesses a nine-pane layout while Herdr now has sixteen panes per page, cannot preview all authoritative pages, and cannot protect an inspected plan against changes. | `topology/TerminalLauncher.tsx` `nodeToSeat`, saved `live:true`, `PANE_CAP=9`; daemon `terminal-service.ts` `previewView`, `expectedPlan`, provider `panesPerPage`; `herdr-adapter.ts` `HERDR_PANES_PER_PAGE=16`. | Passive daemon preview, explicit Open, named absent/degraded seats, provider availability, actual page geometry, plan ID in Open, 409 refresh path. |
| P1 | A saved view whose ID matches a rig name opens the rig from the GUI. | GUI `buildLauncherViews` uses bare `sv.id`; daemon `resolveView` tries rig first then saved fallback. TUI builds `saved:${s.id}` and daemon gives that prefix precedence. | Test same-name rig/saved view and send the explicit `saved:` token; preserve requested target through preview/open. |
| P1 | Workflow Resume cannot select among multiple unresolved failure occurrences. Aborted workflows also lack a declared GUI status type. | GUI `postResume` sends only `actorSession`; daemon `workflow-runtime.ts` `resumeFailureOccurrence` rejects omitted `occurrenceId` unless exactly one unresolved occurrence exists. `workflow.ts` supports `aborted`; UI enum omits it. | Failure list, exact occurrence/decision payload and replay semantics; all five statuses; display conflicts/rejections without replaying the write. |
| P1 | Modern deliberate per-seat startup/resume/fresh/context continuation is absent. Legacy Launch/Restore controls cannot express its inspected revision and explicit fresh choice. | No GUI `/api/startup` consumers. TUI `startup.ts`; daemon `routes/startup.ts` owns revisions and native history choices. | Read each seat's observed state/history/revision; resume exact history; fresh consent bound to selected seat/revision; prerequisite/context continuation; reread after lost response. |
| P2 | Configuration browser and gateway Connections observability are absent despite existing raw settings editing. | No GUI `view=browser` or `/api/gateway/connections` consumer. `useSettings` uses raw general map; TUI Configuration combines general, Slack, people, hosts and health policy sources. | Full read-only inventory and source/application coverage; gateway configured vs applied vs verified vs externally reachable remains distinct. |
| P2 | Durable queue Recent and Pulse are absent; event FIFO/log/audit are different records and cannot provide this parity. | TUI `render.ts` `recentLines`; `pulse/pulse-model.ts`; no GUI `/api/queue/recent-transitions` or `/api/stream/list` consumer. GUI feed keeps at most 100 received events. | Bounded persisted chronology and Pulse joins with explicit scope/freshness, true referent counts, blocker owner lookup, no idle inference from missing activity. |
| P2 | Generic spec deep-link redirects use a name where the library expects an opaque ID. “Generate workflow” navigates to agent generation. | `ui/src/routes.tsx` `/specs/$specKind/$specName` passes only `specName` as `entryId`; daemon library IDs encode source/path or workflow name/version. `SpecsLibraryPage.tsx` toolbar maps Generate workflow to `/specs/agent`. | Resolve actual library ID by kind/name with ambiguity handling, or eliminate misleading routes; route workflow generation to an appropriate supported flow. |

## Source notation and API envelopes

The matrices describe the audited baseline. Implementations should update affected rows with verification evidence as capabilities are completed.

All paths in the matrices are relative to `packages/`. `T:` means `tui/src/`; `U:` means `ui/src/`; `D:` means `daemon/src/`. “Present” means an implementation exists in source; it does not mean a rendered flow was exercised. “Partial” means a related surface exists with missing facts/semantics. “Missing” means no equivalent source consumer was found. “Native equivalent” means browser-native interaction or local CLI fallback is the appropriate equivalent.

| API shorthand | Actual contract / owning route |
| --- | --- |
| Topology | `GET /api/rigs/summary`, `/api/ps`, `/api/rigs/:id/nodes`, `/api/rigs/:id/graph`, `/api/rigs/:id/nodes/:logicalId`, `/api/review/agents`; `D:routes/rigs.ts`, `ps.ts`, `review.ts`. |
| Health | `GET /api/health?limit=…[&scope_type=…&scope_id=…&severity=…&status=…]`, `GET /api/health/:findingId`; `D:routes/health.ts`. Both scope params must be supplied together. Keep records, coverage and truncation metadata. |
| Projects / Scopes | `GET /api/scopes/projects`; `GET /api/scopes?detail=1&project=<id>&projectRoot=<root>[&mission=<name>]`; `/api/scopes/slice?mission=…&slice=…`, `/api/scopes/narrative?mission=…&slice=…`; `D:routes/scopes.ts`, `domain/workspace/project-read.ts`. Project-aware requests carry both exact catalog ID and root. |
| Execution | `GET /api/views/execution?mission=…&project=…&projectRoot=…`; `D:routes/views.ts`, execution view plugin. The generic view response contains `rows`; the selected execution row carries sources, `derived_at`, q1–q6 projections, readiness and `lifecycle_instances`. |
| Slice detail | `GET /api/slices/:directory?mission=…&project=…&projectRoot=…`; `D:routes/slices.ts`. Do not confuse display ID, directory and mission/project identity. |
| Terminal | `GET /api/terminal/views[?detail=1]`, `/api/terminal/preview?view=…[&provider=…]`, `/api/terminal/status[?provider=…]`; `POST /api/terminal/open {provider?,view,expectedPlan?}`; `D:routes/terminal.ts`, `domain/terminal/terminal-service.ts`. Preview serves `planId`, provider availability, composed pages and grids. HTTP 200 alone does not prove tiles opened. |
| Attention | `GET /api/attention[?item=<typed-id>]`; `GET /api/queue/human-updates?limit=20`; `D:routes/attention.ts`, `queue.ts`. Unified `AttentionRead` has `items`, `detail`, `detailError`, `sources`, `readAt`; item types and source pointers survive navigation. Human-updates has its own bounded response and detail composition. |
| Queue / Recent | `GET /api/queue/list?attention=1`, `?state=blocked`, `?state=in-progress`, `?state=pending&limit=50`, `?state=done,handed-off&limit=20`, `/api/queue/:qitemId`, `/api/queue/recent-transitions?scope=instance\|rig[&rig=<name>]&limit=20`; `D:routes/queue.ts`. State lists are bounded creation-ordered windows, not total finish history. |
| Settings browser | `GET /api/config?view=browser`; `D:routes/config.ts`, `domain/user-settings/settings-browser.ts`. Contract: `readOnly`, `observedAt`, `home`, `entries`, `sources`, `exclusions`. Distinct from raw `/api/config` `{settings,feedHostSubscriptions}`. |
| Connections | `GET /api/gateway/connections`, `/api/gateway/slack/manifest`; `D:routes/gateway.ts`, `domain/gateway/connections-projection.ts`. Browsing is passive; readiness/verify operations can contact Slack and must remain explicit. |
| Control plane | `GET /healthz`; running version/commit/selfHostId and event-loop evidence; old `/api/health-summary/version`, `/nodes`, `/context` are additive different projections. |
| Specs | `GET /api/specs/library[?kind=…]`, `/api/specs/library/:id/review`, `/api/rigs/:id/spec.json`; `D:routes/spec-library.ts`, `rigs.ts`. Use actual catalog IDs. |
| Files | `GET /api/files/roots`, `/api/files/read?root=…&path=…`, `/api/files/list`, `/api/files/asset`; `D:routes/files.ts`. Current text read includes `absolutePath`, `mtime`, `contentHash`, `truncated` and optional binary/size metadata. Roots/path boundaries remain authoritative. |
| Workflows | `GET /api/workflow/list`, `/specs`, `/:id`, `/:id/trace`, `/:id/guidance`, `/:id/revision`, `/operations/:key`; lifecycle compile/instantiate/revision and occurrence-specific resume APIs; `D:routes/workflow.ts`. Rich `/:id` adds frontier packets, failure occurrences, boundary obligations, reconciliation, guidance and unknowns. |
| Startup | `GET /api/startup/prerequisites`, `/:rigId`; `POST /api/startup/terminal`, `/kernel {runtime}`, `/:rigId/:logicalId {action,revision}`; `D:routes/startup.ts`. Mutations preserve daemon-side native identity/authorization requirements. |
| Crash cart | Offline `rig crash-cart --json` detector/ledger read; after daemon is started: `POST /api/crash-cart/restore-fleet`, `GET /api/crash-cart/restore-fleet/:attemptId`, `POST …/:attemptId/cancel`; `D:routes/crash-cart.ts`. Browser cannot fetch from a stopped server. |
| Live / Stream | TUI `/api/activity/events` taxonomy/freshness invalidations and `GET /api/stream/list?direction=latest&limit=5`; web topology `/api/events`, workflow `/api/workflow/sse`, persisted queries. Different SSE event families are not automatically interchangeable. |

## Topology section

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Host → rig → pod → agent drill with qualified identity | `T:navigator.ts`, `state.ts`, `render.ts`; served node identity | Present: `/topology`, `/topology/rig/$rigId`, pod and seat routes, `U:components/topology/ScopePages.tsx` | Preserve identity across selected hosts and duplicate logical names; selection is not enough without host scope | Topology | Two hosts/rigs with identical labels; each drill and Back returns to the same origin entity. |
| Instance-wide seat table, rig lifecycle and inventory failure | `T:render.ts` `instanceContentLines`; summary plus node inventory | Present: host table/tree/graph and `SeatOverviewTable` | Partial: canonical health and persisted Recent absent; failed inventory must not become zero seats | Topology, Health, Recent | Running, stopped, empty, unavailable rig inventory produce different rows/counts. |
| Rig/pod table: seat, runtime, model, context, state, queue, work, now, actions | `T:render.ts` `agentColumns`, `queueFacts`; observed nodes and queue | Present: `U:components/topology/TopologyTableView.tsx`, `SeatOverviewTable.tsx`, `RigNode.tsx` | Check all queue counters, null context and full model strings survive responsive layouts; no claim of equality yet | Topology, Queue | Mixed runtimes, unknown model/context, stopped session, queued/working/blocked seat; table and detail agree. |
| Runtime marks and authoritative activity taxonomy/reason | `T:topology/runtime-marks.ts`, `hydrate.ts`; node `activityState` and signal evidence | Partial: RuntimeMark, activity ring, agentActivity and topology activity hooks | GUI still carries multiple older activity projections; current taxonomy, decidedBy and evidence reason need explicit comparison | Topology; activity events | Native waiting-input, idle, active, missing/unknown observations produce accurate label/reason, with source/time. |
| Rig/instance overview: lifecycle, shape, members, configuration | `T:render.ts` overview branches | Present: scope overview, rig status, env/spec views | Health and queue Recent not incorporated; observed lifecycle must stay distinct from configured topology | Topology; spec.json; rig status | Empty rig vs all running vs recoverable vs degraded; authored configuration cannot override observed state. |
| Served topology graph, edges and entity drill | `T:topology/render-graph.ts`, `graph-types.ts`; daemon graph | Present: `RigGraph`, `HostMultiRigGraph`, graph/tree/table/terminal modes | Functional data parity largely present; graphical reliability/large-N verification still required | Topology | Disconnected graph, pod names, infrastructure, loops and 100+ nodes render and select without crashes. |
| Graph styles hatchet/braille/fallback | `T:topology/styles/*`, style registry | Native equivalent: web graph/tree/table modes | Terminal glyph styles need no literal clone; maintain a readable non-3D mode | Topology | Keyboard/accessibility and reduced-motion paths show the same entities/actions as any rich graph. |
| Canonical health summary and scoped Health tab | `T:health/health-model.ts`; same record set filtered by stable scope | Missing | Add host/rig/seat health; avoid interpreting no records as healthy | Health | Scoped records, indeterminate/stale findings, partial coverage and local/remote unsupported state remain distinguishable. |
| Recent queue transitions in collapsed overview and full tab | `T:render.ts` `recentLines`/`recentDetailLines` | Missing: Log/Feed and audit-history read different records | Persisted original transitions with actor/time/change/qitem/target; bounded window disclosure | Recent | Reload browser, compare transition IDs/time/actor with daemon; rig view excludes unrelated rigs. |
| Recent detail: original row and deep drill to target | `T:render.ts` `recentTargetAction`; source matching | Partial: eventRoute opens legacy rig/event routes | Preserve original selected transition when lists refresh; use typed target plus qitem lookup | Recent, Queue, Topology | Transition with unknown owner reveals pointer without selecting another seat; resolved original row remains inspectable. |
| Agent context meter and raw tokens/window | `T:render.ts` `agentDetailLines` | Present: `ContextUsageRing`, `LiveNodeDetails`, node overview | Freshness and unknown semantics must match; canonical context-health evidence absent | Topology, Health | Null usage shows unknown; stale sample displays source/time; raw totals and percentages agree with endpoint. |
| Agent current activity and attention reason | Node activityState/needsInput; review projection | Present: agent detail, NeedsYouAccordion, review bands | Partial: canonical signal explanation/decider and healthy-empty semantics | Topology, review agents, Health | Needs-input without actionable qitem shows reason and no invented approval action. |
| Agent current work, full queue depth, next work and recent finished window | `T:render.ts` queue detail and `hydrate.ts` queue joins | Partial: node currentQitems and project Queue panels | Need separated in-progress/blocked/pending/full counters with bounded-source disclosure and stable links | Queue; node inventory | More than display limit; count vs shown rows truthful; handoff/blocked owner distinctions retained. |
| Effective seat spec/profile/version/hash versus authored library | Node resolvedSpecName/profile/version/hash; `T:render.ts` spec section | Partial: LiveNodeDetails compact spec and library link | UI NodeDetail type omits resolvedSpecHash; running consumer facts and authored source may differ | Topology, Specs | Change library after launch; effective hash/profile unchanged and clearly labeled until native adoption. |
| Cross-navigation `spec-of <agent>` and `running <spec>` | `T:commands/registry.ts`, `navigator.ts` | Partial: library and agent spec links | Add actual observed consumer list with qualified seat links; do not infer consumers from shared directories | Topology, Specs | Same spec across rigs; missing library item; effective binding with authored source drift. |
| Explicit per-seat Run and rig/pod Open terminal | TUI typed actions; `DaemonClient.launchNode`/`openTerminal` | Present: node launch controls and TerminalLauncher | Modern startup action/revision selection and preview plans absent | Node launch, Startup, Terminal | Running seat reports already-running; no duplicate spawn; Open consumes explicitly inspected view. |

## Specs section

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Browse rig/agent/workflow catalog by kind, filter and drill | `T:hydrate.ts`, `navigator.ts`; library entries | Present: `/specs`, SpecsTreeView, SpecsLibraryPage and LibraryReview | Generic kind/name route uses wrong ID; future/invalid entries need honest unavailable states | Specs | User/built-in same name plus workflow versions; select exact entry and display diagnostic invalid YAML. |
| Purpose, source type/state/path and current source | `T:render.ts` `specSourceLines`, source provenance; current file | Partial: LibraryReview ProvenanceBadge, raw YAML | Need explicit authored source vs stored/generated/library representation; current source metadata | Specs, Files | Edit file after cache/launch; raw/current source action names which bytes/time/hash were read. |
| Rig topology tab: pods/members/runtime and edges | `T:render.ts` rig-spec topology; structured review graph | Present: RigSpecDisplay/SpecTopologyPreview | Data largely present; malformed/legacy graph and empty state must match | Specs | Pod-aware and legacy specs; no graph supplied; a broken source never crashes the page. |
| Rig configuration tab: declared runtime/profile/member refs and resources | Structured review; `T:render.ts` configuration branch | Present: RigSpecDisplay, review panels | Observed consumer/runtime comparison incomplete | Specs, Topology | Declared vs observed model/profile drift shown without replacing source declarations. |
| Complete YAML read with file/source affordance | `T:render.ts` YAML tab, `reading.ts` | Present: YAML/raw review and MarkdownViewer raw toggle | Native equivalent for copy/wrap; metadata/truncation must remain visible | Specs, Files | Long/multiline YAML remains complete or labeled truncated and can be copied. |
| Agent skills/guidance/plugins/subagents/startup files/profiles/resources | `T:render.ts` agent-spec detail | Present: AgentSpecDisplay, AgentPluginsList, SkillDetail/PluginDetail pages | Coverage likely broader in web; inspect missing/unknown field handling and exact source routing | Specs; library skills/plugins/files | Every declared resource is visible; unknown plugin/skill is named, not dropped; file links stay in configured root. |
| Agent declared-by refs and observed running seats | `T:render.ts`, actual topology binding plus authored rig refs | Partial: library used-by relationships and node detail | TUI distinguishes declared consumer from observed seat; provide both categories | Specs, Topology | Rig declares spec with no launched seats; another rig's live consumer resolves to its exact seat. |
| Workflow spec roles, steps, status/version/source | `T:render.ts`; catalog workflow review | Present: LibraryReview workflow graph, workflow instance band | Rich runtime reconciliation/obligations do not follow from the spec graph | Specs, Workflows | Versioned cached spec vs current source vs compiled running graph distinguishable. |
| Source errors and missing catalog entries remain navigable/inspectable | `T:hydrate.ts`, `reading.ts` | Partial: library error rows | No fabricated source fallback; corrupt YAML/source deletion must not become ordinary empty catalog | Specs, Files | Unavailable and malformed source rows identify their own failure and retry correctly. |

## Scopes section: projects, missions, execution and slices

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Exact workspace catalog project picker and root identity | `T:state.ts`, `navigator.ts`, `hydrate.ts`; ProjectRead | Missing: `/project` means configured workspace | Add catalog identity and source/error rows | Projects | Two projects with same mission/slice names; exact ID/root survives reload/deep link and unknown ID is rejected. |
| Project → mission → execution row → slice/source tree | `T:scopes/scopes-model.ts` explorer; execution source join | Partial: ProjectTreeView, portfolio/mission/slice routes | Add project-aware coordinates and typed workflow/packet/execution children | Projects, Scopes, Execution | Browse each catalog root; no global indexer data leaks into another selection. |
| Read selected project/mission/slice source | `source` command, project source action, `reading.ts` | Partial: README Docs/files views | Carry exact project sourcePath/root; canonical current-file hash/time/absence | Scopes, Files | Same filename in two roots; source action opens selected one; symlink/path errors stay explicit. |
| Mission NOW, NEXT, PROGRESS and historical lifecycle as separate facts | `T:execution/execution-model.ts` overview | Partial: Project overview/progress/story/status chips | Missing execution projection and native outcome rollup | Execution, Scopes | Declared done with unaccepted outcomes; current active lane without product acceptance; stale/absent execution stays unknown. |
| Waves/sequencing with every slice and dependency order | Execution q2 plus scope joins; `waveRows`/`waveDetail` | Partial: StoryGraph, ProjectTreeView, progress heatmap | Present graph isn't equivalent to canonical waves, basis and authored planning guidance | Execution | Parallel and sequential waves; no omission beyond viewport; open wave then correct member slice. |
| Needs-human at affected mission/slice | Execution park/activity facts and human gate | Partial: review NeedsYouAccordion, slice review | Join canonical execution qitem/park evidence to exact slice and project | Execution, Queue, Attention | Human blocked vs agent blocked vs unknown; each opens the affected slice/request and names what is blocked. |
| Slice identity/status/stage/proof/locks/spec SHA/PRD presence | `T:scopes/scopes-model.ts` `scopeIdentityLines` | Partial: Slice overview and docs tabs | Native locks, source-grounded SHA and readiness revision not fully surfaced | Scopes | Locked spec, delivery lock, missing PRD, declared stage and native judgment disagreement all visible. |
| Intent and mini-requirements, collapsible independently | `scopeContractLines` from store projection | Partial: SliceReview intent and AcceptanceTab checkboxes | Need canonical miniRequirements/intent, not arbitrary document checkbox completion | Scopes | Requirements retain full text/source; collapse does not change totals or acceptance. |
| Proof contract item pairing with retained drops/media, all rounds | `scopeContractLines`, `proofEvidence`; README contract and C1 drop projection | Partial: ProofTab PROOF.md/media, TestsVerificationTab matched packets | File gallery is useful but does not reproduce contract pairing/current judgment | Scopes, Files | Multiple rounds, mismatched drops, source citation and media; pairing is not acceptance. |
| Current attributed proof judgments, actor/time/reason/evidence SHA/corrections | `proofProvenanceLines`, native readiness items/history | Partial: readiness chips; ProofTab parses PASS/PARTIAL/FAIL from prose | Missing native judgment provenance/revision/current versus retained history | Scopes, Execution, Attention | Corrected/rejected/stale evidence judgment; only current native verdict drives readiness; prose PASS stays labeled artifact verdict. |
| Readiness configuration, revision, policy, source observation and publication separation | `T:scopes/scopes-model.ts` ReadinessSnap | Partial: useSlices ProofReadiness carries a small subset | Need full canonical provenance; publication must not be implied by outcome acceptance | Scopes, Execution | Native policy configured/unconfigured; readiness source edit invalidates revision and updates without reload. |
| PROGRESS.md narrative display independent of counts | `narrative` command; raw scope narrative | Present: mission/slice progress Markdown, timeline | Keep narrative separate from authoritative outcomes and lifecycle | Scopes, Files | Checkbox edits in PROGRESS do not change native accepted outcome totals. |
| Slice execution ladder: locked/built/reviewed/merged/live with each derivation basis | `execution-model.ts` RUNGS and slice detail | Missing | Serve per-rung yes/no/undetermined/N/A; evidence missing is unknown, not waiting/completed | Execution | Candidate tag missing/review record missing/adoption unknown; inspect each rung basis without invented verdict. |
| Claimed lane: seat/activity, repo/ref/worktree/dirty and fragile join basis | Execution q1 lane detail | Partial: topology currentQitems and file/status panels | No execution lane/repo join detail page | Execution | Fragile shared-directory join explicitly identified; stable seat link and exact repo/ref evidence retained. |
| Park/pickup rows: queue state, blocker/wake, timestamp and pickup context | Execution q5 park detail | Partial: queue drawer/review diagnostics | Missing typed lane/park execution detail and underlying basis | Execution, Queue | Fired wake without pickup, parked row with explicit blocker, missing source; display exact fields/time. |
| Mission evidence groups and source/derivation pages | `execution-model.ts` sourcesDetail/evidenceDetail | Missing | Canonical source basis, derived time, shared gaps and unconfirmed members | Execution | Opening shared gap lists affected slices; source record stays visible after missing evidence instead of green status. |
| Planning guidance and parallelism/care projection | Execution q3/q6 and planning_guidance | Partial: authored README/steering | Add served guidance with scope/wave/source attribution; don't reinterpret prose into state | Execution | Wave-specific guidance remains attached to correct wave and labels source. |
| Slice rich six-tab payload only when opened | `DaemonClient.sliceDetail`, page-scoped hydration | Present: useSliceDetail and slice tab components | Pass mission/project ID/root and cancel replaced requests; don't read all details on landing | Slice detail | Duplicate slice directories; rapid navigation discards stale result; unused tabs issue no file/detail request. |
| Mission workflow list + frontier work packets | `workflow-model.ts` overview; lifecycle_instances | Partial: WorkflowsPage, instance band and old currentStep panel | Current frontier_packets and mission-bound identity missing from web composition | Execution, Workflows | Parallel frontier, waiting/closed workflows and empty frontier retain workflow vs product completion separation. |
| Workflow packet purpose, summary, owner, blocker, transition actor/time | `workflowDetail` packet branch | Partial: queue drawer and old workflow trail | Need exact packet-specific detail linked to mission/workflow/seat | Execution, Workflows, Queue | Multiple frontier packets; each owner/blocker/drill corresponds to selected packet. |
| Packet wake kind/phase/live/unconsumed/delivery/ref/expiry and schedule | `workflowDetail` packet wake branch | Missing | Expose wake and scheduler evidence with “check, not guaranteed delivery” semantics | Execution | Fired-unconsumed wake vs no wake vs expired schedule; no false readiness claim. |
| Exact targeted action, gate, acceptance/evidence refs | Served packet targeted_action; no local adjudication | Partial: generic workflow Resume and review controls | Show complete served next action; generic action cannot target every occurrence/frontier state | Execution, Workflows | Long quoted command remains copyable byte-for-byte; no guessed actor/packet/occurrence. |
| Boundary obligations, receipt state/actor/evidence and release housekeeping | Lifecycle boundary_obligations and step objectives | Missing | Receipt-recorded is not accepted; required vs extension and optional successor explicit | Execution, rich workflow show | Completed lifecycle with missing boundary receipt, optional successor absent/present, attribution in detail. |
| Compiled graph/source receipts and dependencies | Lifecycle identity, graph_source, sources, compiled_input_digest | Partial: cached spec graph and trace timeline | GUI draws cached spec shape; needs actual bound source/graph comparison | Execution, Workflows | Edit authored spec after compilation; display compiled and authored digests separately. |
| Authored/running plan reconciliation, reasons and safe next operation | Lifecycle reconciliation; workflow revision endpoint | Missing | source-only vs executable change, apply command, operation-key recovery | Execution, Workflows | Source-only edits do not replay finished work; accepted revision and lost-response recovery report exact operation. |
| Unresolved failures and precise occurrence-specific remediation | Lifecycle failure_occurrences/unknowns | Partial/broken: generic Resume | Select occurrence, copy served action, retain source conflicts and unknowns | Execution, Workflows | Two unresolved failures; send exact occurrence/decision; resolved replay bytes differing yields clear conflict. |

## Terminals section

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Independent Saved/Derived view catalog and filter | `T:terminals/terminal-model.ts` | Partial: TerminalLauncher inside rig-scope desktop tab bar | No independent terminal catalog destination; saved/derived browsing depends on a rig and `hidden lg:inline-flex` excludes smaller viewports | Terminal | Zero rigs but saved views; small viewport; all saved/derived targets accessible without opening tiles. |
| Catalog names/membership do not claim readiness before preview | TUI catalog `readinessUnverified:true` | Broken: saved live=true, derived live from session name | Use passive readiness-unknown label until authoritative preview | Terminal | Dead pane with retained canonical session and absent saved member never says every seat live. |
| Explicit `saved:`/`rig:`/`pod:`/`mission:`/`slice:` target tokens | TUI terminal commands and resolver contract | Partial: all kinds present in launcher | Saved bare ID collision; selected mission/slice set only from active slices | Terminal | Saved ID equals rig name; completed mission/slice target supported or explicitly unavailable with exact reason. |
| Authoritative passive preview and provider availability | TUI terminal-preview/readTerminals | Missing | Consume `/preview` and provider status; no launch during browse | Terminal | Provider down; view missing; absent/degraded member; preview does not create Herdr space. |
| Page navigator, true equal-cell grid, labels/blank fillers | Preview `composed.pages`, `grids` | Broken/partial: local capped icon grid only | Herdr 16-per-page vs guessed 9; all pages, blank fillers and labels missing | Terminal | 0/1/10/16/17/33 members and provider variants; exact daemon page count/grid shown. |
| Member interactive/read-only mode and SSH caveat | Preview readOnly and paneCommand | Partial: crossRig boolean chip | Mixed saved member modes and remote SSH unverified caveat must be per member | Terminal | Mixed local/remote, read-only/interactive saved members; shown modes match composed commands. |
| Open only available/attachable preview, with `expectedPlan` | TUI open action carries preview.planId | Missing protection: launcher Open sends provider/view only | Preserve inspected plan and explicit refresh on `preview_changed` 409 | Terminal | Member state changes between preview/Open; no tiles opened for stale plan and no automatic replay. |
| Named opened/absent/degraded results and zero-open failure | TUI open result; `openTerminal` rejects opened.length=0 | Present: describeOpenResult checks opened.length | Keep full result including pages/notes; pending and lost-response ambiguity need truthful state | Terminal | HTTP200 provider-unavailable is failure; partial opened result names every omitted seat and actual page count. |
| Refresh preview and last Open result scoped to selected view | TUI state terminalView/terminalResult | Partial: mutation data persists across selection | Old result must remain labeled with original provider/view, or clear on target change | Terminal | Open A then select B/provider change; no previous result appears as B's success. |
| Saved YAML membership only, no geometry editor | TUI disclosure and daemon store | Present: disabled Save arrangement seam | Both surfaces lack saved editing; no parity requirement to invent an editor | Terminal | Clearly explain storage semantics and no misleading editable “show-limit” setting. |
| Embedded browser terminal/chat/live preview | No literal TUI equivalent; terminal-native attach is TUI's path | Web-ahead: FocusedTerminal, ProgressiveTerminal, pins/chat | Preserve useful browser functionality while parity is added | Terminal WS, node preview/chat | Resize/reconnect/reduced motion, terminal budget and route teardown do not orphan active sessions. |

## Needs section (Attention)

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Human requests separate from updates; urgency/scope/time | `T:attention/attention-model.ts`; AttentionRead | Partial: For You lenses/raw queue/events | Unified canonical action/update set absent | Attention | Mixed queue/proof/lifecycle/health items; no update is promoted to approval. |
| Recipient and what request unblocks | Canonical AttentionItem recipient/unblocks/project | Partial: review needs-you/evidence cards | Missing full canonical dependent task set and exact project attribution | Attention | External human address and explicit human blocker show correct recipient; tier-only row with no human recipient excluded. |
| Full request body, supplemental detail, source and queue transition history | `/attention?item=queue:…` detail | Partial: QueueItemViewer and feed hydration | Canonical detail lines, posture and correlation guidance missing | Attention, Queue | Missing summary fallback; complete long body; transition history/actor; no read-as-approval. |
| Current native outcome updates and corrected judgment history | Canonical proof: typed IDs and native judgments | Missing from durable feed | Avoid lossy 100-event FIFO or PROOF prose replacement | Attention | Browser opened after judgment occurred still shows update; correction points to prior judgment and hashes. |
| Manifest-bound workflow terminal receipts/mission outcomes | Attention lifecycle source | Missing | Keep lifecycle receipt and current workflow state apart from product acceptance | Attention | Bound terminal receipt with accepted/rejected outcomes; unbound historical workflow excluded. |
| Canonical health updates | Attention health source | Missing | Open original finding evidence; source freshness/coverage | Attention, Health | Health item source links exact finding; stale/indeterminate remains unknown. |
| Delivered non-action human updates | `composeHumanUpdates`; human-update IDs | Missing | Read human-updates, preserve delivered detail and “no action needed” | Attention human-updates | Delivered update survives reload; never adds Approve/deny button; update disappears only as bounded window dictates. |
| Detail continuity after request closes or feed row leaves current list | `attention/source-continuity.ts`; opened queue detailOnly | Partial: current feed card reads queue item | Canonical selected source remains inspectable without re-inserting into action-required | Attention | Resolve open request elsewhere; selected detail continues with closed state, Action-required lens no longer includes it. |
| Typed source file/evidence links with root resolution | Canonical detail.files, `reading.ts` | Partial: EvidenceOpener/FileLink | Need project identity, absolute/relative refs, anchor, unavailable root handling | Attention, Files | Relative ref resolves only within attributed project; ambiguity/outside roots does not search unrelated roots. |
| Source coverage, unavailable/partial and read time | AttentionRead.sources/readAt | Missing or partial through aggregate host status | Empty/error/partial/unknown not conflated; expose each source's limit and failure | Attention | One failed project proof source while queue loads; feed declares incomplete; retry updates source status. |
| Filter served items, Back and “viewing is not approval” | TUI filter/attention detail | Present: For You lenses, filters and review actions | Preserve explicit correlated Slack decision route where required | Attention; existing mission-control actions | Browsing, opening evidence, copying and refreshing send no decision or outbound message. |
| Multi-host attention/agents | TUI broad review reads aggregate host status; web selected-host settings | Present/web-ahead: FleetPage, subscriptions and daemon aggregate | Do not silently mix local canonical items with remote queue-only coverage | Attention aggregate, review fleet | Unreachable/auth-failed/unsupported host has explicit coverage; origin host travels through each drill. |

## System section: canonical Health

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Instance health findings sorted and summary by active severity/category | `T:health/health-model.ts`; canonical service | Missing: Settings Status only daemon/cmux/rig counts | Add canonical table/detail and scope-linked count summary | Health | Active/resolved/indeterminate findings; severity totals correspond exactly to served records. |
| Detector/category/scope/status/confidence/freshness | HealthRecord | Missing | Show all fields, source observation times and stable finding ID | Health | Old source or missing evidence cannot paint healthy; age isn't client poll age. |
| Explanation, threshold, policy version and suggested inspection | healthDetailLines | Missing | Canonical explanation instead of generic “agent stopped” diagnostics | Health | Same detector under different policy/threshold; exact suggested inspection remains copyable. |
| Operating posture, phase and oversight reason | HealthRecord.operatingPosture | Missing | Expose declared/derived posture attribution without granting authority | Health | Specialist-autonomy and coordination context; unknown phase/source stays explicit. |
| Diagnosis/ceremony stage, context refs, state/hash and assessment basis | HealthRecord.ceremony | Missing | Evidence-derived ceremony interpretation and referenced source records | Health | Missing context ref/hash, disputed stage; no accepted status synthesized from absence. |
| Typed queue/watchdog/work-graph/activity/context/model/lifecycle evidence | healthDetailLines evidenceText switch | Missing | Preserve evidence type and identifiers, observedAt for each record | Health | Fixture covering all eight evidence types; show raw unexpected future fields without crashing. |
| Canonical coverage/truncation/not-assessed/empty/remote-unavailable | health model coverage and scope rules | Missing | Empty is not healthy, partial is not complete, remote unsupported is not local data | Health | 200 record cap reached; partial detector input; failed read; stable seat ID missing; remote selection. |
| System grouping: Health / Configuration / Connections | `T:sections.ts` SYSTEM_SECTIONS | Partial: Settings/Policies/Log/Status Explorer | Add discoverable canonical health/configuration/connections destinations while retaining existing settings/policy/log | Health, Settings browser, Connections | Keyboard and small viewport reach all three; no required detour through topology or hidden link. |

## Config section

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Full read-only resolved settings browser | `T:config/config-model.ts`; settingsBrowser | Partial: editable SettingsTab/general raw settings | Missing multi-source browser contract and application/visibility/source metadata | Settings browser | All daemon-served entries shown even beyond legacy UI union; unsupported browser shape clearly rejected. |
| Ten categories: instance/context/display/waiting/recovery/activity/agents/Slack/all/sources | CONFIG_CATEGORIES and deterministic category function | Partial: manually maintained UI categories | Queue/workflow/recovery/snapshot/retention/native runtime and future keys absent/incomplete | Settings browser | Every served key reachable under All; category counts match entries; new unknown key discoverable. |
| Label/key multiword search and full value detail | configEntries/configDetailLines | Partial: SettingsTab rows | Search beyond manual setters; values never silently clipped in detail | Settings browser | Long instruction/path, zero/false/null, unknown default, dynamic person/host binding key. |
| Env/file/default precedence, defaultKnown, scope and application | ConfigEntry fields | Partial: raw ResolvedSetting value/source/defaultValue | Need source path/state, overriding env explanation and adoption not inferred | Settings browser | Env-over-file setting and edited unapplied running-service setting shown accurately. |
| Withheld credential presence, unavailable source and exclusions | ConfigEntry.visibility/reason; sources/exclusions | Missing multi-source semantics | Keep sensitive contents withheld while showing presence and coverage | Settings browser | Credential reference present vs missing; source error vs unset; no token/body exposure in DOM/copy. |
| Slack/people/host/health policy settings in same inventory | Browser groups/subject | Missing | Browser inventory is not the general SettingsStore map | Settings browser | Subjects/handles/bindings distinguished; registry unavailable named independently of general settings. |
| Display timezone and persistent setting guidance | TUI timezone command; ui.timezone | Partial: browser uses local date formatting, ThemeSelector | Add explicit display timezone using configured selection; show daemon vs browser scope | Settings browser, Control plane | Same ISO under two timezones; invalid zone falls back truthfully; missing timestamp never fabricated. |
| Sources/coverage: target, daemon identity, home, observedAt, exclusions | configSourceLines | Partial: daemon version footer/status | Need complete source browser and exact instance target | Settings browser, Control plane | Foreign/old/incompatible daemon payload remains unverified; missing source path explained. |
| Refresh read-only, no runtime adoption claimed | configLines and passive hydration | Partial: raw settings mutations/reset and auto queries | Native-equivalent Refresh action; keep write settings separate from observational inventory | Settings browser | Refresh sends only reads; saved config change doesn't claim restarted native agents/gateway. |
| Editable settings/policies/workspace scaffold | TUI gives canonical CLI guidance rather than broad mutations | Web-ahead: useSet/ResetSetting, compaction form, init-workspace | Preserve existing useful controls; missing browser metadata does not justify bypassing native permissions | Raw config existing write endpoints | Unknown/removed key and env override errors; existing files preserved by init; no global permission/model changes. |

## Connections section

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Passive gateway/human/routes/work observability | `T:connections/connections-model.ts`; connectionsProjection | Missing | Create System Connections view; refresh doesn't send messages or contact Slack | Connections | Browse/refresh produces only projection reads; no external verify/send side effect. |
| Running control-plane version/commit/dirty/self-host/target/process/home/time | ControlPlaneRead and ConnectionsRead | Partial: HostIndicator, useDaemonVersion and status | Full identity/instance/source context absent | Control plane, Connections | Running daemon differs from UI build/launcher; don't label compile-time version as daemon. |
| Resolved host/workspace/operator settings and precedence | ConnectionsRead.settings/settingsSource | Partial: SettingsCenter | Add relationship between configuration and actual connection state | Connections, Settings browser | Env override and unavailable settings file; current settings do not prove runtime adoption. |
| Slack config source, hidden credential presence and running applied state | ConnectionsRead.configuration/configSource/running | Missing | Distinguish configured/enabled/running/changed/degraded/unverified reachability | Connections | Config changed after gateway wire built; outbound ready at activation while current creds differ. |
| Outbound thresholds, inbound state/new destination and seat drill | Gateway runtime/current config | Missing | Show routing facts with correct inbound-new vs existing-conversation reply semantics | Connections, Topology | Inbound target resolves to exact seat; unknown seat address remains inspectable, no fallback twin. |
| Last verification state/time/actor and bounded audit caveat | ConnectionsRead.verification/nextAction | Missing | Verification is historical scopes/channel check, not delivery/readership | Connections | Old verified configuration vs current state; no matching audit check shows unknown. |
| Own Slack app setup: manifest link/scopes/events/YAML plus CLI sequence | slackSetupLines and SlackManifestRead | Missing | Passive manifest route with native browser link/copy, missing-endpoint fallback guidance | Connections manifest | Not configured vs unavailable source; expand YAML and link; no credentials embedded. |
| Humans: address/name/class/availability/bindings/primary/eligibility | ConnectionsRead.humans/registry | Missing | Registry eligibility is not assignment/reachability; show excluded/unknown routing | Connections | Primary and fallback handles, outbound-only binding, excluded human, unavailable registry. |
| Current human-directed queue requests in loaded window | Bounded join of queue lists by human address | Partial: feed human queue items | Show limited correlated requests and exact qitem/actor/state; no global total claim | Connections, Queue | More than three requests; named bounded sample; external address owner. |
| Cross-links to rig lifecycle/authored spec/workflows/requests/Back | Connections projection plus loaded topology/specs | Partial: shell nav | Add contextual destinations preserving origin and identity | Connections, Topology, Specs, Scopes | Go from gateway target to seat then Back to same connection selection and scroll. |
| Explicit verify/enable/disable/edit guidance | TUI renders CLI instructions, not automatic operations | Missing | Support copy/intentional actions; externally contacting verification must be explicit | Existing gateway operations, CLI guidance | Passive view never verifies; manual action names instance and displays audited outcome/errors. |

## Pulse (cross-section tab)

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Needs You exception strip | `T:pulse/pulse-model.ts` needsRows | Partial: For You/review bands | Pulse exception surface absent; named summary and age from served timestamps | Queue attention | Zero omitted strip vs failed/deferred read remain distinct; same qitem under pulse and request detail. |
| Parked with Baton: in-progress + idle owner + no handoff | parkedRows queue/activity join | Missing | Null activity must not be inferred idle; idle duration from owner's lastActivityAt | Queue in-progress, Topology | false/true/null terminalActive, existing handoff, missing owner; only exact parked predicate matches. |
| Blocked on Agents: blocker qitem pointer → actual owner | blockedRows, bounded blocker hydration | Partial: blocked feed cards | Resolve blockedOn qitem ownership; retain raw pointer when unresolved; human blockers excluded | Queue blocked, queue item | Blocker queue owned by another agent; human-owner exclusion; failed lookup never names guessed agent. |
| NOW active seats joined to current work | nowRows; active === true | Partial: topology/table activity | Add compact operator lane with true active-set count and full-identity drill | Topology, Queue in-progress | Active with no work still visible; idle/unknown excluded; multiple queues/duplicate names handled. |
| JUST FINISHED bounded newest-finished-first | finishedRows; tsUpdated sort of bounded list | Partial: ephemeral event feed | Persisted bounded completion window, explicitly not global history | Queue done,handed-off | Old-created recently finished item and window limits labeled; don't call served window total completed count. |
| UP NEXT unclaimed pending with served order/overflow | upNextLane | Partial: project queue | Unclaimed predicate, served order and explicit overflow; five-row cap isn't full backlog | Queue pending | Claimed pending excluded; >5 rows yields truthful served count and overflow affordance. |
| Footer active/parked/waiting counts and hydration freshness | buildPulseModel computed from same referents | Missing | Counts derive from displayed sets; distinguish served bounds and hydration stamp | Same joins | Rapid update changes lanes/counts together; missing timestamp doesn't become “just now.” |
| Entity drill/unknown identity disclosure and reduced-motion fresh activity flash | seatRowAction; render-pulse; motion context | Partial: topology clickable rows/animated activity | Pulse drill and one-shot flash budget missing; 3D mode must obey same identity/motion limits | Topology; activity SSE | Duplicate seat names and absent owner reveal canonical address; reduced motion disables pulse/flash without hiding state. |

## Startup, recovery and daemon-down entry

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Distinct probing/up/down/unverified and first-run states | `T:startup.ts`; crash-cart detector PID/probe evidence | Partial: DaemonHealthProvider and setup BootstrapWizard | HTTP failure alone cannot prove daemon down; browser not served when daemon stopped | Control plane; local crash-cart | Refused/timeout/401/foreign server distinguished; no restore action on merely unverified reachability. |
| Choose rig then exactly one seat; actual history/observed state | StartupSeat revision/hasHistory/observed/intendedAction | Missing | New startup chooser alongside legacy bulk recovery | Startup | Mixed live/resumable/new/unverified/transport-unavailable seats; only selected seat is touched. |
| Resume previous exact native conversation | startup launch action=resume and daemon verifier | Partial: node Launch/rig Restore | Need native history reason and inspected revision before action | Startup | Exact Codex/Claude native ID preserved; no cross-runtime ID or shared-directory inference. |
| Deliberate fresh conversation consent bound to seat/revision | startup consent and freshAllowed | Missing | Fresh start must not be generic automatic fallback after resume fails | Startup | State changes after inspect cause conflict; declined fresh does no write; old histories retained. |
| Finish context delivery after native prerequisite | contextPending/action=continue | Missing | Expose incomplete fresh-context delivery and exact continuation | Startup | Resolve trust/login manually then continue; no duplicate context/fresh turn; reread observation. |
| Start terminal service only, without launching seats | startup `/terminal` | Missing | Explicit service-only action for transport_unavailable | Startup | All seat PIDs remain unchanged except newly selected subsequent launch; service read back. |
| Prepare kernel topology with available runtime, choose operator afterward | prerequisites + `/kernel` | Partial: BootstrapWizard broad initialization | Dedicated kernel flow is topology preparation, not automatic fleet start | Startup | Auth/install availability shown; create kernel then seat selection; no native model/credential defaults changed. |
| Existing native terminal inspection and return | startup onNative terminal attach | Native equivalent: focused web terminal or provider Open | Browser cannot attach its parent terminal; provide correct existing session opening | Terminal/WS, Startup | Attention-required runtime opened intact; return refreshes actual state; no implicit launch. |
| Busy operation serialization, navigation/help independent, no POST replay | StartupController.run/readRig failure recovery | Partial: local mutation pending buttons | Need revision-aware readback after failed/lost response; Back does not claim accepted operation canceled | Startup | Double click, navigate during request, lost network response: one operation then observed reread. |
| Offline local specs/intent reader with roots/hash/time/binary/truncation | `T:local-reading.ts`; CLI local-reading helper | Native equivalent: terminal fallback; browser Files requires daemon | Cannot recreate local disk access from unavailable HTTP server; explicit unsupported/offline handoff required | Local CLI, Files when up | Down/unverified GUI explains available CLI path; do not reuse cached live topology as current disk truth. |
| Offline durable rig/seat ledger and where work stopped | crash-cart model/ledger explorer | Missing; browser served by stopped daemon cannot read ledger | Terminal-specific local inspection; optional separate local launcher would require new architecture | CLI crash-cart | Document browser limitation; no fabricated offline counts or inferred resumability. |
| Restore fleet kickoff/poll with retained attempt ID and truthful rollup | restore-lifecycle model + conductor | Missing: SnapshotPanel per-rig restore is different | Once daemon connected, web can adopt existing conductor lifecycle | Crash cart | Restore returns accepted attempt, progressive counts and fully/partial/failed/not-attempted rows; never treat kick as success. |
| Cancel stop-before-next-rig, reattach after view detach/errors | restore-lifecycle, restore-input | Missing | Retain attempt ID and canceled state; current rig continues until safe boundary | Crash cart | Cancel accepted while current rig runs; reload/reattach; no second kickoff; “view paused” isn't “restore stopped.” |
| Result triage: exact rig/seat need and remediation | crash-cart/triage.ts | Partial: LaunchRecoveryModal/snapshot outcomes | Fleet-level bounded rollup and per-seat triage missing | Crash cart | Mixed partial outcome; every attention_required record visible and keyboard reachable; all-failed isn't green. |
| Offline daemon start/onboarding/doctor guidance | crash-cart/start-daemon and first-run view | Native equivalent: CLI fallback | Browser cannot invoke service if no server is running; no remote daemon-start inference | Local CLI | Explain local command and read-only offline options; verify target upon reconnection. |

## Shell, reading, live responsiveness and terminal-specific equivalents

| TUI capability | Source of truth | Existing GUI equivalent | Gap | Daemon API | Acceptance verification |
| --- | --- | --- | --- | --- | --- |
| Complete discoverable command registry/help/palette and contextual availability | `T:commands/registry.ts`, completion/palette/help | Partial: AppShell links and buttons; no equivalent complete palette | Browser navigation/action discovery can implement equivalent inventory; keep unavailable reasons | Same underlying contracts | Keyboard-only discovery of every operator action; unavailable daemon/project/source state explains why. |
| `:` section jump and host/rig/pod/agent/spec named drill | Registry plus qualified resolver | Native equivalent: routes/explorer/search/links | Need exact ambiguous-name handling and accessible path to hidden workflow/agent/fleet routes | Topology, Specs, Projects | Ambiguous labels never pick first entity; all eight section equivalents reachable. |
| `/` and `find` row text filter | Registry/filter reducer | Present: local list filters, feed lenses/table filter | Cross-view filter behavior/history may vary; no requirement to copy command syntax | Existing reads | Clears correctly; filter no matches != empty source; retained selection/scroll after Back. |
| Back restores previous view/selection/scroll and source continuity | state navigation history | Native equivalent: router/browser history | View-mode tabs are component state; ensure Back restores operator context and explicit deep link origin | None | Drill long list → detail → Back; tab/filter/row/scroll unchanged; no selection jump on refresh. |
| Scroll/top/bottom, wheel, resize, focus, text-copy mode | input/state/visual-layout/print-for-copy | Native equivalent: browser scrolling, keyboard focus and clipboard | Terminal copy/mouse escape handling doesn't need cloning | None | Long panes, narrow viewport, keyboard focus retained through updates; full copied identity/action. |
| Read `<root>/<path>#heading`, files and external refs | `T:reading.ts`, fileLines/externalLines | Present: FilesWorkspace, MarkdownViewer/FileViewer/FileLink | Need current metadata/truncation and correct root/project/anchor continuity | Files | Missing/binary/oversize/outside-root/changed hash; heading anchors and escaped terminal content safe. |
| Refresh scoped view with deadline and cancellation | PageRead, refresh/hydrate models | Partial: React Query refetch/poll plus some forwarded AbortSignals | Standardize no hung spinner, source-specific failure, no stale response replacing changed context | All reads | Never-resolving request, abort on rapid navigation, older result late, optional source failure; responsive Help/Back. |
| Activity SSE taxonomy and quieter trailing refresh/backoff | `T:live-events.ts`, refresh.ts; activity event stream | Present: shared topology-events, useGlobalEvents, useRigEvents; workflow SSE | Event families differ; new canonical query families need invalidation, reconnection and fallback refresh | Live/Stream | Event burst coalesces requests; disconnect/reconnect invalidates current data; ignored event types don't freeze readiness. |
| Passive bounded rig stream footer with stored chronology | TUI streamLatest/source continuity | Missing: web ephemeral activity is different | Add durable stream optional surface; do not make event FIFO the only history | Live/Stream | Reload retains latest served messages; maintained active stream ordering and limits explicit. |
| Reduced motion and finite activity flashes | TUI motion budget | Present: usePrefersReducedMotion and existing motion consumers | Rich 3D must preserve alternate views and never create permanent event-loop/render workload | None; live evidence | OS reduced-motion, background tab, low-power/unsupported WebGL: same data and actions remain usable. |
| Local control socket, rendered/plain captures and agent-driven command query | TUI socket-server protocol | Terminal-specific; web has tests/digital twin | Not an operator GUI parity gap; browser automation/tests can provide equivalent verification, separate authority | Local socket, not daemon REST | Don't expose local control socket through web merely for parity; keep deterministic UI fixtures. |
| Demo fixtures and unavailable/context gating | TUI demo gate/command-context composition | Web twin fixtures and test mocks | Test/demo state never masquerades as real fleet in production | None | Unconfigured/empty startup uses real honest-empty state; fixture data only through explicit test harness. |

## Complete command-to-equivalent checklist

This closes the command registry accounting independently of the section matrices. Commands sharing a capability intentionally share an equivalent. Registry entries are navigation/read operations; recovery/startup also have dedicated keys outside this registry.

| Registry command / aliases | Browser equivalent / inventory row |
| --- | --- |
| `terminals`, `terminal-preview <view>`, `terminal <view>` | Terminal catalog, passive authoritative preview, explicit Open. |
| `attention`, `needs`, `feed` | Canonical Attention plus delivered updates, reachable For You destination. |
| `read <root>/<path>[#heading]` | Configured-root File viewer with source metadata and anchors. |
| `system`, `config [category]`, `setting <key>`, `connections` | Canonical Health, full Configuration browser/entry detail, Connections. |
| `refresh`, `timezone`, `recent <id>`, `back` | Scoped refetch, explicit timezone, persisted original transition detail, browser/context Back. |
| `projects`, `project <id>`, `source`, `mission <name>` | Exact project catalog selection, source reader and mission execution with project identity. |
| `workflow <instance-id>`, `packet <qitem-id>` | Mission-bound workflow and frontier packet detail. |
| `:<section>`, `/<text>`, `find <text>` | Discoverable destination links/palette and row search. |
| `tab <table\|recent\|overview\|graph\|health\|topology\|configuration\|yaml\|pulse>` | Same applicable content capability as responsive tab/view mode; Pulse independent overview is acceptable. |
| `graph`, `g`, `style <name>` | Graph/tree/table/rich-graph view modes; terminal rendering styles need no literal clone. |
| `scroll up\|down`, `top`, `bottom` | Native scrolling/PageUp/PageDown/Home/End in focused content pane. |
| `select-text`, `copy` | Browser text selection and explicit copy affordances. |
| `spec-of <agent>`, `running <spec>` | Effective seat binding → authored spec and observed consumer list → exact seat. |
| `help`, `?` | Complete contextual help/action palette accessible in unavailable/loading states. |
| `reqs`, `narrative` | Collapsible canonical requirements and independent PROGRESS narrative. |
| `host <name>`, `rig <name>`, `pod <name>`, `agent <name>`, `spec <name>` | Qualified explorer/navigation with ambiguity handling and correct catalog IDs. |

## Useful 3D integration opportunities

These are recommendations from the audited model, not new authoritative data or additional acceptance gates:

- Topology: a depth-based host/rig/pod/seat view that supports entity drill, bounded live activity and exact canonical health overlays. Preserve table/tree modes and keyboard selection; depth must expose hierarchy and scope, not obscure labels.
- Execution: spatial wave/dependency layout with current work packets, native outcomes and distinct legacy ladder evidence. Select a node to inspect basis/revision/owner; never animate an unconfirmed rung as complete.
- Terminal preview: a perspective representation of the actual daemon-composed page/grid, using served labels, blank cells and per-member read-only state. Switching pages must preserve the inspected plan ID, and Open must use that plan.
- Health: modest depth can separate current signal, explanation and typed evidence. Freshness/coverage and suggested inspection should remain readable in the ordinary detail panel.

Static art and constant particle motion do not close capability gaps. WebGL should load only on the selected rich view, stop while hidden and have a truthful accessible fallback with identical selections/actions.

## Verification plan and limits

No product code was modified by this audit. Source searches covered the actual section/command registries, TUI render/hydration/state/model modules, GUI routes/hooks/components and owning daemon routes/services. The source comparison proves missing consumers and incompatible declared contracts; it does not prove every existing browser journey works. No runtime tests were run for a documentation-only inventory, and no installed fleet operations were attempted.

Before claiming full GUI parity, use isolated deterministic API/UI fixtures for the matrix acceptance cases, then actual local browser verification against a private test daemon. Node 24 is required. Run focused UI tests for the affected surfaces, `npm run test:ui`, `npm run lint` and `npm run build` according to the repository guidance. Daemon/startup/queue/terminal mutations need appropriate isolated route or stub-agent regression evidence; mocks alone cannot prove native provider identity/trust/resume behavior.

Existing TUI regression suites provide semantic examples: `health-view`, `attention`, `feed-source-continuity`, `project-navigation`, `mission-outcomes`, `execution-view`, `workflow-journey`, `config-journey`, `connections-journey`, `terminal-journey`, `startup-*`, `crash-cart-*`, `pulse-live`, `refresh-*`, `reading-*`, `command-registry-parity`, `navigation-continuity` under `packages/tui/test/`. Reuse their edge-case intent rather than merely duplicating snapshots. Existing GUI suites under `packages/ui/test/` cover terminal launch/reconnect, project identity/state, readiness chips, live invalidation, proof file errors and large-N topology; those do not yet demonstrate the missing canonical consumers.

Recommended implementation cohorts:

1. Canonical Health and Attention: shared typed reads/invalidation; system/scoped findings; action/update detail continuity; delivered updates and source coverage. Test incomplete sources and retained closed records first.
2. Exact project and execution: catalog selection and URL/query identity; native scope contract/readiness; mission waves and current workflow packets; full slice evidence basis. Use duplicate mission/slice names across catalog projects as the core isolation regression.
3. Authoritative terminal catalog/preview/Open: provider-specific pages, collision-safe tokens, plan protection and small-screen availability. Layer useful spatial previews over the served composition.
4. Full Configuration and Connections: observational source/browser contracts and gateway runtime adoption versus configuration/verification. Keep passive reads separate from explicit externally contacting actions.
5. Workflow lifecycle detail: frontier packets, failure occurrences, boundary receipts, source reconciliation and operation-key recovery. Reuse execution's typed model rather than rebuilding competing interpretations.
6. Deliberate startup/recovery: revision-bound per-seat chooser, fresh consent and context continuation; connected fleet conductor/reattach/cancel. Explain offline browser limits through local CLI guidance.
7. Persisted Recent, Pulse and stream: durable transition/window models and bounded queue/activity joins with true counts, unknown activity and source availability.
8. Rich 3D enhancement: hierarchy, waves and exact terminal page geometry; lazy-load the selected view, stop hidden animation, preserve keyboard/ordinary views and reduced motion.

Each completed row should be updated with actual implementation paths and executed verification evidence. This inventory is the capability-level acceptance ledger for GUI modernization.
