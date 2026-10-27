# Cross-host web terminals

A local web UI can open an interactive terminal on a registered HTTP host when
that host explicitly opts in. In the local daemon's `hosts.yaml`:

```yaml
hosts:
  - id: workstation
    transport: http
    url: http://workstation:7433
    terminal_proxy: true
    bearer_file: /path/to/remote-terminal-token
```

Use the remote daemon's **terminal** token (`OPENRIG_TERMINAL_BEARER_TOKEN`),
not its mission-control write token. Bearer pointers are resolved on each
connection. Omit the pointer only for an intentionally tokenless trusted host.
A host with a bearer pointer requires a terminal token on the local daemon too;
the proxy cannot turn protected remote terminals into unprotected local ones.

The browser connects to its local daemon at
`/api/terminal/<session>?host=<registry-id>` with its local terminal token.
The shared browser boundary and local terminal authentication run before any
remote dial. The daemon then uses the registry URL and sends the remote token
only in an Authorization header, without the browser Origin or token query.
Connections have a 15-second handshake deadline and never reconnect or replay
input in the daemon. Pre-connect input is limited to 32 frames / 256 KiB.

`GET /api/hosts` advertises `terminalProxy: true` only for opted-in HTTP hosts
while the local web-terminal lane is enabled and the token posture above is
satisfied. SSH hosts, hosts without opt-in and older daemons remain read-only.
The message composer and other writes remain local-only. Opt-in grants the
local UI the same interactive terminal authority as the remote terminal route.

Remote close codes are preserved. Reserved observations 1005/1006 cannot be
sent on the wire and become 1011; remote HTTP 401/403 becomes policy close
1008. The UI stops reconnecting on 1001, 1008 and 1011. A remote session must
exist, and stock 0.7.2's input guard requires a managed seat binding even though
an unmanaged tmux shell can be viewed. The remote needs no proxy-specific change:
0.7.2 and 0.7.3 accept the same keys, literal text and per-viewer scroll frames.
