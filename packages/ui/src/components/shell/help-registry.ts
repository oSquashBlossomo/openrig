// Help & action inventory: every TUI section (packages/tui/src/sections.ts)
// and registry command (packages/tui/src/commands/registry.ts) with its GUI
// destination, or the established CLI/native equivalent when the browser has
// no equivalent. Availability is stated, never implied:
//
// - "gui":      a reachable GUI destination performs it;
// - "partial":  reachable, with a named gap;
// - "pending":  not available in this GUI yet; the stated equivalent applies;
// - "cli":      offline/native operation with the existing CLI equivalent;
// - "native":   the browser's own behavior is the equivalent.
//
// No command syntax or API is invented here; the targets are existing routes.

export type HelpAvailability = "gui" | "partial" | "pending" | "cli" | "native";

export interface HelpTarget {
  label: string;
  /** Existing app route path (static). */
  to: string;
  search?: Record<string, string>;
}

export interface HelpEntry {
  id: string;
  /** TUI command/section form, as typed in the TUI. */
  tui: string;
  title: string;
  description: string;
  availability: HelpAvailability;
  targets?: HelpTarget[];
  /** Existing CLI commands that perform or inspect the same thing. */
  cli?: string[];
  /** Keyboard or gesture in the GUI. */
  keys?: string;
  /** Gap or reason, with the current alternative. Required for partial/pending/cli/native. */
  note?: string;
}

export interface HelpSection {
  id: string;
  title: string;
  /** TUI section name this group corresponds to, if any. */
  tuiSection?: string;
  summary: string;
  /** App paths for which this section is the contextual "On this page" help. */
  matches: (pathname: string) => boolean;
  entries: HelpEntry[];
}

const starts = (...prefixes: string[]) => (p: string) => prefixes.some((prefix) => p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || p.startsWith(`${prefix}?`));

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: "topology", tuiSection: "topology", title: "Topology",
    summary: "Hosts, rigs, pods and seats on the selected host, as a graph, 3D view, table or terminal grid.",
    matches: starts("/topology", "/rigs", "/agents", "/fleet"),
    entries: [
      { id: "topology", tui: ":topology", title: "Open topology", description: "All rigs on the selected host.", availability: "gui", targets: [{ label: "Topology", to: "/topology" }] },
      { id: "drill", tui: "host|rig|pod|agent <name>", title: "Drill to a host, rig, pod or seat", description: "Use the Topology Explorer tree or a table row; rig, pod and seat pages have exact URLs that Back returns from.", availability: "partial", targets: [{ label: "Topology", to: "/topology" }], note: "Named lookup is by tree/table, not a typed name box. Duplicate names stay qualified by rig/pod." },
      { id: "tabs", tui: "tab table|graph|overview|health|recent|pulse · graph (g)", title: "Switch view tab", description: "Graph, 3D, Table and Terminal tabs on topology pages; Overview on rig and pod pages; Recent and Pulse on their own page.", availability: "partial", targets: [{ label: "Topology", to: "/topology" }, { label: "Pulse", to: "/pulse" }, { label: "Recent", to: "/pulse", search: { view: "recent" } }], note: "The TUI health tab maps to canonical Health filtered by scope; Recent and Pulse are one page here rather than topology tabs." },
      { id: "fleet", tui: "—", title: "Fleet attention and rig agents", description: "Cross-host attention altitude and per-rig agent review.", availability: "gui", targets: [{ label: "Fleet", to: "/fleet" }, { label: "Rig agents", to: "/agents" }] },
      { id: "style", tui: "style <name>", title: "Graph render style", description: "TUI ASCII graph styles have no browser equivalent; the GUI graph and 3D view render natively. Theme is chosen in the top bar.", availability: "native", note: "TUI-only rendering option." },
    ],
  },
  {
    id: "specs", tuiSection: "specs", title: "Library & specs",
    summary: "Rig and agent specs, skills, plugins, images and context packs.",
    matches: starts("/specs", "/plugins", "/files"),
    entries: [
      { id: "specs", tui: ":specs · spec <name>", title: "Browse the library", description: "Kinds, specs, skills and plugins.", availability: "gui", targets: [{ label: "Library", to: "/specs" }, { label: "Skills", to: "/specs/skills" }, { label: "Plugins", to: "/specs/plugins" }] },
      { id: "spec-of", tui: "spec-of <agent> · running <spec>", title: "Spec of a seat / seats running a spec", description: "Spec of a seat: open the seat from Topology; its page shows the launched spec name, version and hash, the authored reference, and which library entry matches exactly (or every candidate when several do). Seats running a spec: open the spec in the Library; its review lists the seats observed running it, and a kind/name address with several matching entries asks you to choose one.", availability: "gui", targets: [{ label: "Topology", to: "/topology" }, { label: "Library", to: "/specs" }], note: "Observed seats come only from rig inventories that could be read; an unreadable rig is listed as unknown, not empty. A name matching several library entries is never resolved to the first one. Spec drift is not asserted when the library serves no source hash." },
      { id: "read", tui: "read <root>/<path>[#heading]", title: "Read a file in a configured root", description: "Files workspace over the configured readable roots: exact root, folder, file and heading in the address, Markdown with heading anchors and relative links/images resolved against the file, and Back through each step.", availability: "partial", targets: [{ label: "Files", to: "/files" }], note: "Files are read from the connected instance only; a reference produced by another host is shown as not forwarded. Not yet confirmed in a browser." },
    ],
  },
  {
    id: "scopes", tuiSection: "scopes", title: "Projects, missions & workflows",
    summary: "Exact catalog projects, mission execution, slices, sources and workflow instances.",
    matches: starts("/project", "/workflows", "/workflow"),
    entries: [
      { id: "projects", tui: "projects · project <id>", title: "Choose an exact catalog project", description: "Project ID and canonical root travel together; nothing is selected implicitly.", availability: "gui", targets: [{ label: "Catalog projects", to: "/project/catalog" }, { label: "Workspace", to: "/project" }] },
      { id: "mission", tui: "mission <name> · reqs · narrative", title: "Mission story, waves and requirements", description: "Story, workflows, capacity/parks and sources tabs on the catalog project page.", availability: "gui", targets: [{ label: "Catalog projects", to: "/project/catalog" }] },
      { id: "source", tui: "source", title: "Read project, mission or slice source", description: "Sources and Docs tabs read only the chosen document, through the exact project scope.", availability: "gui", targets: [{ label: "Catalog projects", to: "/project/catalog" }] },
      { id: "workflow", tui: "workflow <id> · packet <qitem>", title: "Workflow instances and packets", description: "Frontier packets, occurrence-specific resume, revision and abort with readback.", availability: "gui", targets: [{ label: "Workflows", to: "/workflows" }] },
    ],
  },
  {
    id: "terminals", tuiSection: "terminals", title: "Terminal views",
    summary: "Saved and Derived terminal views with passive preview and explicit Open. Works with zero rigs.",
    matches: starts("/terminals"),
    entries: [
      { id: "terminals", tui: "terminals", title: "Browse terminal views", description: "Saved views and per-rig derived views; filter by name, token or member seat.", availability: "gui", targets: [{ label: "Terminal views", to: "/terminals" }] },
      { id: "terminal-preview", tui: "terminal-preview <view>", title: "Preview a typed view", description: "Enter a full saved:/rig:/pod:/mission:/slice: token; preview is read-only.", availability: "gui", targets: [{ label: "Terminal views", to: "/terminals" }] },
      { id: "terminal", tui: "terminal <view>", title: "Open a view in the provider", description: "Open is explicit, on the connected local instance only, against the plan you previewed.", availability: "gui", targets: [{ label: "Terminal views", to: "/terminals" }], note: "Opening creates provider panes on the connected host; a lost response is reported as uncertain." },
    ],
  },
  {
    id: "needs", tuiSection: "needs", title: "Attention & activity",
    summary: "Canonical human requests, outcome/health updates and delivered updates; the live Activity feed keeps its own actions.",
    matches: starts("/for-you"),
    entries: [
      { id: "attention", tui: "attention (needs, feed)", title: "Inspect requests and updates", description: "Canonical Attention with independent delivered updates; viewing is not approval.", availability: "gui", targets: [{ label: "Attention", to: "/for-you", search: { view: "attention" } }, { label: "Activity", to: "/for-you", search: { view: "activity" } }] },
      { id: "recent", tui: "recent <transition-id> · tab recent · tab pulse", title: "Recent transitions, Pulse and the stream", description: "Durable recent transitions (instance or exact rig), the six Pulse lanes and the maintained stream, with exact drill-down and Back.", availability: "gui", targets: [{ label: "Pulse", to: "/pulse" }, { label: "Recent", to: "/pulse", search: { view: "recent" } }, { label: "Stream", to: "/pulse", search: { view: "stream" } }], note: "Recent and Pulse describe the connected local instance; remote hosts are not served." },
      { id: "audit", tui: "—", title: "Audit history", description: "Mission-control action audit. Distinct from named entity lookup.", availability: "gui", targets: [{ label: "Audit history", to: "/search" }] },
    ],
  },
  {
    id: "system", tuiSection: "system", title: "System · Health",
    summary: "Canonical findings for the connected instance; distinct from daemon process Status.",
    matches: starts("/settings/health", "/settings/status", "/settings/log"),
    entries: [
      { id: "system", tui: "system", title: "Canonical health findings", description: "Filters, exact finding detail, coverage and evidence.", availability: "gui", targets: [{ label: "Health", to: "/settings/health" }] },
      { id: "status", tui: "—", title: "Daemon process status and log", description: "Process health and the daemon log.", availability: "gui", targets: [{ label: "Status", to: "/settings/status" }, { label: "Log", to: "/settings/log" }], cli: ["rig daemon status", "rig daemon logs"] },
    ],
  },
  {
    id: "config", tuiSection: "config", title: "Configuration & settings",
    summary: "Read-only resolved configuration, editable instance settings and policies.",
    matches: starts("/settings/configuration", "/settings/policies") ,
    entries: [
      { id: "config", tui: "config [category] · setting <key>", title: "Browse resolved configuration", description: "Grouped entries with source, default, scope and application; withheld values are never shown.", availability: "gui", targets: [{ label: "Configuration", to: "/settings/configuration" }] },
      { id: "settings", tui: "—", title: "Edit instance settings", description: "Supported workspace/files/progress settings, with reset and Init Workspace.", availability: "gui", targets: [{ label: "Settings", to: "/settings" }, { label: "Policies", to: "/settings/policies" }], cli: ["rig config get <key> --show-source", "rig config set <key> <value>", "rig config reset <key>"] },
      { id: "timezone", tui: "timezone", title: "Display timezone", description: "Times show in the connected instance's ui.timezone, with zone and source visible. As in the TUI, changing it is a persistent setting made from the shell.", availability: "cli", cli: ["rig config set ui.timezone Europe/London", "rig config reset ui.timezone", "rig config get ui.timezone --show-source"], note: "This page adopts the value on each settings read; OPENRIG_UI_TIMEZONE overrides the file on that instance." },
    ],
  },
  {
    id: "connections", tuiSection: "connections", title: "Connections",
    summary: "Slack gateway configuration, running adoption, dated verification and the human registry.",
    matches: starts("/settings/connections"),
    entries: [
      { id: "connections", tui: "connections", title: "Gateway, recipients and routes", description: "Configured vs running vs dated check, the new-inbound seat on this instance, each person's bindings and up to three open requests from loaded queue windows, and rig lifecycle/seats/authored spec with links to work and requests. Browsing never contacts Slack.", availability: "gui", targets: [{ label: "Connections", to: "/settings/connections" }] },
      { id: "slack-actions", tui: "—", title: "Verify, enable or set up Slack", description: "These contact Slack or change gateway state. As in the TUI, the Connections page shows the guidance and does not run them; run them deliberately on that instance.", availability: "cli", cli: ["rig slack setup", "rig slack verify", "rig slack enable"], note: "Browsing Connections never contacts Slack or runs verification." },
    ],
  },
  {
    id: "operations", title: "Startup, restore & offline",
    summary: "Per-seat startup, connected fleet restore, and what to do when the daemon is down.",
    matches: starts("/settings/startup", "/settings/restore"),
    entries: [
      { id: "startup", tui: "startup chooser", title: "Resume, start, continue or fresh-start one seat", description: "Served seat facts, deliberate action, confirmed Fresh, retained receipts.", availability: "gui", targets: [{ label: "Seat startup", to: "/settings/startup" }] },
      { id: "restore", tui: "crash-cart restore", title: "Restore every rig on this instance", description: "Single kickoff, progressive receipts, pause/resume observation, stop before next rig.", availability: "gui", targets: [{ label: "Fleet restore", to: "/settings/restore" }], cli: ["rig restore <snapshotId> --rig <rigId>"], note: "The CLI restores one rig from a named snapshot; fleet restore is the GUI kickoff." },
      { id: "offline", tui: "crash-cart cockpit (daemon down)", title: "Daemon unreachable", description: "The browser cannot start a stopped daemon or read native state. Use the local CLI or the TUI cockpit on that machine.", availability: "cli", cli: ["rig daemon status", "rig daemon start", "rig crash-cart --json", "rig tui"], note: "Help and Back keep working while reads fail." },
    ],
  },
  {
    id: "navigation", title: "Navigation & keys",
    summary: "Shell-wide movement, filtering, scrolling and copy.",
    matches: () => false,
    entries: [
      { id: "jump", tui: ":<section>", title: "Jump to a section", description: "Primary rail (menu on phones), the Explorer, or this page's links.", availability: "gui", targets: [{ label: "Help", to: "/help" }] },
      { id: "back", tui: "back", title: "Back to previous view", description: "Browser Back restores route, selection, filters and tab; list pages also offer a ← list control on narrow screens.", availability: "native", keys: "Alt+← / browser Back", note: "Browser history is the equivalent." },
      { id: "find", tui: "/<text> · find <text>", title: "Filter rows", description: "Each list page has a Find field; the filter rides the URL where the page supports it.", availability: "gui", keys: "Tab to the Find field" },
      { id: "refresh", tui: "refresh", title: "Read again", description: "Each read surface has a Refresh control next to its read time; stored values do not prove runtime adoption.", availability: "gui", keys: "Refresh button on the page · browser reload (⌘R / Ctrl+R) re-reads everything" },
      { id: "scroll", tui: "scroll up|down · top · bottom", title: "Scroll", description: "Native page scrolling.", availability: "native", keys: "PgUp / PgDn / Home / End", note: "Browser scrolling is the equivalent; list pages restore their scroll on Back." },
      { id: "copy", tui: "select-text (copy)", title: "Select and copy", description: "Native text selection; exact IDs and paths have Copy buttons.", availability: "native", note: "Browser selection and clipboard are the equivalent." },
      { id: "help", tui: "help", title: "This help", description: "Open from the ? button in the top bar or by pressing ? outside a text field.", availability: "gui", keys: "?" },
      { id: "lists", tui: "↑/↓", title: "Move within a list", description: "Arrow keys, Home and End move between rows; Enter opens the row.", availability: "gui", keys: "↑ ↓ Home End Enter" },
    ],
  },
];

export function helpForPath(pathname: string): HelpSection | undefined {
  return HELP_SECTIONS.find((section) => section.matches(pathname));
}

export function filterHelp(sections: readonly HelpSection[], query: string): HelpSection[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...sections];
  return sections.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => {
      const hay = [section.title, entry.tui, entry.title, entry.description, entry.note, ...(entry.cli ?? []), ...(entry.targets ?? []).map((t) => t.label)]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      return words.every((word) => hay.includes(word));
    }),
  })).filter((section) => section.entries.length > 0);
}
