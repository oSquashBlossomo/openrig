import type { Context, Next } from "hono";
import WebSocket from "ws";
import { getSelfHostId, resolvesToLocalHost } from "./fanout-contract.js";
import { loadHostRegistry, resolveHost, type HostEntry, type HttpHostEntry } from "./hosts-registry-reader.js";
import { resolveBearer } from "./remote-daemon-http.js";

export function terminalProxyEligible(host: HostEntry, localToken: string | null): host is HttpHostEntry {
  return host.transport === "http" && host.terminal_proxy === true
    && (!(host.bearer_env || host.bearer_file) || !!localToken);
}

/** Runs after the browser boundary and terminal authentication, before any remote dial. */
export function terminalProxyAdmission(localToken: string | null) {
  return async (c: Context, next: Next) => {
    const hostId = c.req.query("host");
    if (hostId === undefined || resolvesToLocalHost(hostId, getSelfHostId())) return next();
    const refuse = (failureClass: string, status: 403 | 502) => c.json({ error: "remote_terminal_refused", boundary: "MH-3", hostId, failureClass }, status);
    const loader = (c.get("hostRegistryLoader" as never) as typeof loadHostRegistry | undefined) ?? loadHostRegistry;
    const registry = loader();
    if (!registry.ok) return refuse("registry", 502);
    const resolved = resolveHost(registry.registry, hostId);
    if (!resolved.ok) return refuse("unknown-host", 502);
    if (!terminalProxyEligible(resolved.host, localToken)) return refuse("terminal-proxy-disabled", 403);
    const bearer = resolveBearer(resolved.host, {});
    if (!bearer.ok) return refuse("auth-failed", 502);
    let url: URL;
    try {
      url = new URL(resolved.host.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return refuse("invalid-url", 502);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/$/, "")}/api/terminal/${encodeURIComponent(c.req.param("sessionName")!)}`;
    } catch { return refuse("invalid-url", 502); }
    c.set("terminalProxyTarget" as never, { url: url.toString(), token: bearer.token });
    return next();
  };
}

type BrowserSocket = { readonly readyState: number; send(data: string | Uint8Array): void; close(code: number, reason: string): void };

/** One connection, one outbound leg: early frames drain once; closed input is never replayed. */
export function remoteTerminalHandlers(target: { url: string; token?: string }) {
  let remote: WebSocket | undefined;
  let browser: BrowserSocket | undefined;
  let closed = false;
  const early: string[] = [];
  let bytes = 0;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true; early.length = 0; bytes = 0;
    // 1005/1006 are observations, not legal wire close codes.
    const wireCode = code === 1005 || code === 1006 ? 1011 : code;
    const safeReason = target.token && reason.includes(target.token) ? "remote terminal closed" : reason;
    try { browser?.close(wireCode, safeReason); } catch { /* already closed */ }
    if (remote?.readyState === WebSocket.OPEN) remote.close(wireCode, safeReason);
    else remote?.terminate();
  };
  return {
    onOpen(_evt: unknown, ws: BrowserSocket) {
      browser = ws;
      if (closed) return;
      try {
        remote = new WebSocket(target.url, {
          headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
          handshakeTimeout: 15_000,
          followRedirects: false,
        });
      } catch { close(1011, "remote terminal unavailable"); return; }
      remote.on("open", () => {
        if (closed) { remote?.terminate(); return; }
        // Drop input as closing starts; onClose later supplies the actual close code.
        if (browser?.readyState !== WebSocket.OPEN) { early.length = 0; bytes = 0; return; }
        for (const frame of early) remote!.send(frame);
        early.length = 0; bytes = 0;
      });
      remote.on("message", (data, binary) => {
        if (closed) return;
        const payload = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        try { ws.send(binary ? payload : payload.toString()); }
        catch { close(1011, "terminal proxy write failed"); }
      });
      remote.on("unexpected-response", (_req, res) => {
        res.resume(); close(res.statusCode === 401 || res.statusCode === 403 ? 1008 : 1011, "remote terminal refused upgrade");
      });
      remote.on("error", () => close(1011, "remote terminal unavailable"));
      remote.on("close", (code, reason) => close(code, reason.toString()));
    },
    onMessage(evt: { data: unknown }) {
      if (closed || typeof evt.data !== "string") return;
      if (browser?.readyState !== WebSocket.OPEN) { early.length = 0; bytes = 0; return; }
      if (remote?.readyState === WebSocket.OPEN) { remote.send(evt.data); return; }
      const size = Buffer.byteLength(evt.data, "utf8");
      if (early.length >= 32 || bytes + size > 256 * 1024) { close(1009, "terminal input before ready exceeded buffer limit"); return; }
      early.push(evt.data); bytes += size;
    },
    onClose(evt: { code: number; reason: string }) { close(evt.code, evt.reason); },
    onError() { close(1011, "terminal proxy unavailable"); },
  };
}
