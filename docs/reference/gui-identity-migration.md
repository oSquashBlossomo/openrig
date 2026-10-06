# GUI identity migration

The modernized GUI uses exact source identities for library entries and a
geometry-aware browser terminal protocol. When adopting this change, update the
daemon and its bundled UI together. Custom clients and saved references may need
the following adjustments.

## Library references

File-backed specs now use `specfile:v2:` IDs derived from the canonical source
path. Old 16-character hexadecimal spec IDs are deliberately rejected with
`legacy_spec_id` and HTTP 409. They are not redirected, even when only one current
entry appears to match: that would guess which source the saved reference meant.

Run `rig specs ls` or reopen the Library, select the intended source, and save its
current ID. Update bookmarks, scripts and other stored references with that ID.
Moving a source file to a different canonical path changes its identity, so
reselect it after the move as well.

The CLI reserves exactly 16 lowercase hexadecimal characters for legacy IDs.
If a spec's name has that form, use its current ID from `rig specs ls` rather
than its name. Values beginning with `specfile:` are also interpreted as IDs;
an unknown ID never falls through to a different entry with that name.

Agent-image names or versions containing colons now use opaque tuple IDs.
Existing unambiguous `agent-image:name:version` IDs are retained. Legacy IDs
with ambiguous colon-separated values are rejected rather than guessed.
Reopen the image library and copy the current entry's ID when updating those
saved image references.

## Browser terminal clients

The browser terminal WebSocket now requires `protocol=2`. The bundled UI already
sends this parameter and understands the geometry and screen messages. Older
custom clients must implement that protocol before reconnecting; adding the
parameter alone is not sufficient. The daemon rejects clients that omit it
rather than send frames they cannot interpret.

Browser terminal snapshots require [tmux 3.1 or newer](https://github.com/tmux/tmux/blob/3.1/CHANGES)
for `capture-pane -N`,
which preserves written trailing spaces and the native pending-wrap cursor.
Check `tmux -V` when planning adoption. Unsupported capture commands produce an
explicit capture-unavailable notice rather than an invented empty screen.

After updating the daemon and UI, reload older browser tabs to load the matching
client. This protocol change does not authorize changing native pane geometry,
permissions, models or conversation identities.

## Previously pinned native window sizes

The old browser terminal could set a tmux window's `window-size` to `manual`
and resize it to 90×27. That window-local option survives a daemon upgrade.
The new broker preserves the existing policy; it does not guess whether a
manual size came from the old broker or from an operator.

If a previously viewed seat remains pinned, inspect the exact window on the
correct tmux server before changing it. Record its window ID, current geometry,
local option and inherited default:

```sh
tmux list-windows -t '=<session>' -F '#{window_id} #{window_width}x#{window_height} #{window_name}'
tmux show-options -w -t '<window-id>' window-size
tmux show-options -gw window-size
```

Use the same `-L` or `-S` server selector as the installation when applicable.
After confirming the local `manual` override is unwanted, the operator can
remove only that window's override:

```sh
tmux set-option -wu -t '<window-id>' window-size
tmux show-options -wA -t '<window-id>' window-size
```

The window then inherits its existing global policy. If that is also `manual`,
unsetting the local option alone does not enable native-client sizing; choose
the intended policy separately. Attach the intended native client and verify
the resulting dimensions. This recovery may resize the window and is an
explicit operator step, never an automatic migration or browser action.
