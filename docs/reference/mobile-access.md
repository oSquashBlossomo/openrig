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
The terminal applies its own origin/authentication guard. An HTTPS proxy needs
the exact HTTPS origin allowance even when the underlying daemon uses HTTP.

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

Event replay cannot recreate deleted history or recover events from a replaced
database. The canonical readback remains necessary. If an operation's response
was interrupted, inspect its current state and receipt before retrying it.

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
- Inspect long workflow names, identifiers and history in narrow windows.
- On an authorized isolated terminal, check focus, text input, native geometry,
  horizontal panning and history. Reconnection must not resend one-shot text.
- Background Safari and return; briefly disconnect and reconnect Tailscale.
  Confirm refreshed canonical state and no duplicated mutation. Verify an
  uncertain action by reading its receipt before deciding whether to retry.

Physical Safari and real-tailnet checks are recorded separately from automated
UI tests. Publishing or merging frontend changes does not install them into a
running fleet; select and rehearse that rollout separately.
