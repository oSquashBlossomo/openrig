# iPhone and iPad browser access

The mobile GUI targets touch-first Safari on iPhone 15 Pro Max and 11-inch iPad,
in portrait, landscape and narrower iPad windows. Layout follows available space
and input capabilities rather than a device-name check. Keep Safari's page zoom
available and use List when the spatial view is inconvenient.

## Private access through Tailscale

Use one HTTPS origin for the UI, API, event stream and terminal WebSocket.
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can
reverse-proxy a loopback HTTP service inside your tailnet. Its HTTPS endpoint
uses a provisioned certificate. The following is a deployment example, not an
automatic change to a running OpenRig installation:

1. Confirm Tailscale is connected on the host and both Apple devices. Inspect
   `tailscale serve status` first; preserve any existing service configuration.
2. For an unused Serve HTTPS endpoint, proxy the daemon's actual loopback port:

   ```sh
   tailscale serve --bg http://127.0.0.1:7433
   tailscale serve status
   ```

3. In the daemon's managed environment, append the exact HTTPS origin reported
   by Serve to `OPENRIG_ALLOWED_ORIGINS`, preserving existing entries. For example:
   `https://my-machine.example.ts.net`. Include a port when the endpoint uses a
   non-default HTTPS port. An origin has no path or trailing slash.
4. If that hostname is not already recognized as this machine's own name, add
   the exact hostname to `OPENRIG_ALLOWED_HOSTS` too. Follow the existing
   [browser access contract](browser-access.md) when applying the environment
   through the separately planned daemon restart.
5. Open the reported HTTPS URL in Safari. Mount the whole application at `/` so
   relative `/api` and terminal paths reach the same origin. Keep existing
   bearer-token requirements and tailnet access policy in place.

Opening this host from a phone still selects that daemon's **local instance**.
It does not require changing the GUI's selected data source to a remote host.
Source labels and restrictions on remote writes retain their existing meaning.

If the page loads but requests fail, distinguish `untrusted_host`,
`browser_origin_refused`, authentication failure and disconnected Tailscale.
The daemon's shared browser boundary validates the terminal upgrade's host and
origin; terminal-token authentication also applies when configured. An HTTPS
proxy needs the exact HTTPS origin allowance even when the daemon uses HTTP.

## Live terminal controls and recovery

Graph, 3D, agent details and the Terminal grid use the same live terminal.
The key strip provides Ctrl+C, Escape, Tab, arrow keys and Enter when a browser
intercepts a shortcut or the software keyboard lacks it. Controls become active
only after the selected session supplies its native geometry. Opening or fitting
a viewer does not resize that session's native pane.

Connecting and reconnecting states are visible. Each connection has 15 seconds
to become ready; four consecutive unsuccessful attempts stop with a **Retry**
button. A network return, restored browser page or return after at least 30
seconds in the background replaces the connection and rechecks admission.
The daemon also detects unresponsive WebSocket viewers with ping/pong heartbeats.
These steps replace the browser connection, not the agent process.

Input is paused during recovery and is never queued for later replay. After a
disconnect, inspect the terminal before resending a command whose result is
uncertain. If Retry continues to fail through an HTTPS proxy, check the exact
origin allowance above: browsers do not expose the reason an upgrade was refused.

A clipboard paste is sent as one literal text input, keeping its newlines; it
does not press Enter after each line. One paste or keystroke batch is limited to
256 KiB of encoded input (UTF-8, so non-ASCII text reaches the limit with fewer
characters). Larger input is refused with a visible warning before anything is
sent. If the daemon closes the connection because its input buffer overflowed,
the viewer does not reconnect automatically and warns that some input may
already have reached the terminal: inspect it before retrying or resending.

## Connection recovery

The GUI reads current workflow state when its event connection opens or
reopens. A reconnect also replays retained events after the browser's saved
sequence, in bounded pages. A fresh connection receives a sequence checkpoint
without replaying historical workflow outcomes into CLI followers. These are
read-only recovery steps; they do not resubmit workflow operations.

If a saved sequence is ahead of the current log after a database restore or
replacement, the stream resets it to the current checkpoint so new events can
arrive. CLI followers also reread canonical state after opening a replacement
stream, recovering completion, failure or abort that happened while disconnected.

Workflow replay skips malformed event rows with a diagnostic and sequence
checkpoint so later retained events and live updates can continue. Skipping a
damaged row does not reconstruct its payload; current-state readback still applies.

Event replay cannot recreate deleted history or recover events from a replaced
database. The canonical readback remains necessary. If an operation's response
was interrupted, inspect its current state and receipt before retrying it.

## Topology graph on phones and iPads

Graph, 3D and Table remain separate tabs at every width. Phones and other narrow
windows use the responsive touch graph below the 1024px layout breakpoint.
Supported iPad windows use the desktop graph in both portrait and landscape,
with the taller panel described below.

In the responsive touch graph:

- Rigs, pods and seats open progressively. Dense fleets start as rig tiles with
  status counts; expand a rig or pod with its chevron or from the details panel.
  Unreadable, still-loading and not-drawn rigs keep their own tiles.
- Drag to pan and pinch to zoom inside the bounded canvas. Use Fit, + and − for
  the same actions. Scroll the page from outside the canvas.
- A rig or pod tap selects it without navigating. A seat tap opens its guarded
  live terminal in a full-screen modal; Close returns to the graph. The seat's
  details link is an explicit navigation action. Seat selection is kept in the
  URL and is shared with 3D, but an open terminal modal is separate from that
  selection and is not restored merely by browser Back or a saved URL.

On an identified iPad with a window between 600px and 1400px wide and a screen
short side of at least 600px, host, rig and pod Graph views retain the desktop
cards and controls in a taller panel. Lower sections follow it down the page;
scroll to reach them. A narrower iPad split-view window uses the responsive
touch graph. An attached keyboard, mouse or trackpad does not switch the iPad
graph's renderer. Opening the software keyboard keeps that renderer and the
selected terminal mounted.

Tap an agent's card to open its live terminal directly below the iPad graph.
The graph stays mounted, and the terminal is revealed without focusing it or
opening the keyboard. Tap another agent to switch, or tap the same agent again
to reveal its existing terminal. Close releases only the viewer, leaving the
agent running. Seat details remains an explicit link. This inline dock is local
page state: changing source host, scope or view closes it, and returning with
Back or reloading does not reopen it automatically. A current identity or
attachment failure shows a refusal rather than attaching a different seat.

The iPad behavior is scoped by iPad browser identity as well as touch and screen
capabilities; touchscreen capability alone does not opt a desktop into it.
In wide non-iPad windows, Graph clicks retain their existing seat-page
navigation and local cmux focus behavior. Remote sources remain read-only.

## 3D agent workspace

The 3D tab uses a dark studio scene with runtime-specific figures: Clawd for
Claude, a reconstructed Null figure for Codex, and neutral figures when the
runtime is unknown or another provider. Their attribution and reconstruction
details are recorded in
[the mascot notice](../../packages/ui/src/components/topology/spatial/SPATIAL-MASCOTS-NOTICE.md).
Small labels identify seats; selecting one reveals the fuller workspace.

Select a figure or its entry in the seat index to open its live terminal beside
the scene on wide screens, or below it on phones. The workspace also shows
current work, queue, context and relationship details. Switching seats closes
the previous viewer. Opening, resizing or rotating the workspace sends no
terminal input and does not resize the native pane. The terminal follows the
shared limit on live viewers; a released viewer offers Reconnect.

Terminal admission reads the selected seat's current identity and attachment.
If a later read fails or its pane changes, the viewer closes and requires an
explicit Retry or reselection. A registered remote source remains read-only.
Attention, trust and login prompts stay reachable when the current attachment
can be verified; the browser does not approve those prompts automatically.

Luminous arcs represent fresh observed queue creation, handoff or reroute
events with identifiable endpoints. They are bounded effects, not delivery or
read receipts. Historical events remain available in Evidence without replaying
as new traffic. Missing endpoints, disconnected feeds and remote sources do not
produce invented traffic; reduced-motion mode suppresses travel animation.

## Device verification

Record the actual iPad model, OS, Safari version and effective viewport. An
11-inch marketing size alone does not identify its CSS viewport. Desktop size
emulation is a useful regression check; it does not establish physical keyboard,
browser-bar, safe-area or Tailscale behavior.

Before considering a mobile rollout verified, exercise these on both devices:

- Navigate between operator views, open a detail sheet, close it and return with
  browser Back. Confirm the exact seat and source survive navigation.
- Rotate with a sheet open. Check that content and close controls remain
  reachable around the home indicator, camera cutout and Safari bars.
- Edit a disposable file with the software keyboard open; save, discard and
  navigate away and back with a draft. Confirm the intended file and text.
- Tap a spatial seat, orbit with one finger, and pinch/pan with two. Gestures
  and cancellation must not accidentally select a different seat. Check List.
- In the 2D Graph, pan, pinch and tap a rig, pod and seat; rotate with a seat
  selected. A pan ending on a node must not open it, and the page must still
  scroll outside the canvas.
- Inspect long workflow names, identifiers and history in narrow windows.
- On an authorized isolated terminal, check focus, text input, native geometry,
  horizontal panning and history. Reconnection must not resend one-shot text.
- Background Safari and return; briefly disconnect and reconnect Tailscale.
  Confirm refreshed canonical state and no duplicated mutation. Verify an
  uncertain action by reading its receipt before deciding whether to retry.

Physical Safari and real-tailnet checks are recorded separately from automated
UI tests. Publishing or merging frontend changes does not install them into a
running fleet; select and rehearse that rollout separately.
