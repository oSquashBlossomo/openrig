import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket, { WebSocketServer } from "ws";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { hostReadThrough } from "../src/domain/hosts/read-through.js";
import { getSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { remoteTerminalHandlers } from "../src/domain/hosts/terminal-proxy.js";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
import { validateHostRegistry, type HostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const LOCAL = "local-fixture-token";
const REMOTE = "remote-fixture-token";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.unstubAllEnvs(); });

async function fixture(options: { localToken?: string | null; host?: Record<string, unknown>; delay?: boolean } = {}) {
  const received: string[] = [];
  const headers: Array<{ url: string; authorization?: string; origin?: string }> = [];
  let remote: WebSocket | undefined;
  let pending: (() => void) | undefined;
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  cleanup.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); http.close(); });
  http.on("upgrade", (req, socket, head) => {
    headers.push({ url: req.url!, authorization: req.headers.authorization, origin: req.headers.origin });
    const accept = () => {
      if (req.headers.authorization !== `Bearer ${REMOTE}`) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { remote = ws; ws.on("message", d => received.push(d.toString())); ws.send("remote-output"); });
    };
    if (options.delay) pending = accept; else accept();
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address() as { port: number };
  vi.stubEnv("PROXY_REMOTE_TOKEN", REMOTE);
  const hosts = [{ id: "remote", transport: "http", url: `http://127.0.0.1:${address.port}`, bearer_env: "PROXY_REMOTE_TOKEN", terminal_proxy: true, ...options.host }];
  const registry = validateHostRegistry({ hosts }, "fixture");
  expect(registry.ok).toBe(true);
  const app = new Hono();
  const localInputs: unknown[] = [];
  app.use("*", async (c, next) => {
    c.set("hostRegistryLoader" as never, () => registry);
    c.set("tmuxAdapter" as never, { hasSession: async () => true, setWindowOption: async () => ({ ok: true }), resizeWindow: async () => ({ ok: true }), startPipePane: async () => ({ ok: true }), stopPipePane: async () => ({ ok: true }), sendKeys: async (_s: string, keys: string[]) => { if (keys[0]) localInputs.push(keys); return { ok: true }; }, sendText: async (_s: string, text: string) => { localInputs.push(text); return { ok: true }; } });
    await next();
  });
  const token = options.localToken === undefined ? LOCAL : options.localToken;
  app.use("/api/*", browserBoundary({ webUiEnabled: true, bearerTokens: [token], warn: () => {} }));
  app.use("/api/*", hostReadThrough());
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: token });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  injectWebSocket(server); if (!server.listening) await once(server, "listening");
  cleanup.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/api/terminal/scratch`;
  const connect = (query = `?host=remote&token=${LOCAL}`, extra: Record<string, string> = {}) => {
    const ws = new WebSocket(url + query, { headers: { Origin: `http://127.0.0.1:${port}`, ...extra } });
    ws.on("error", () => {}); cleanup.push(() => ws.terminate()); return ws;
  };
  return { app, url, remoteUrl: `ws://127.0.0.1:${address.port}/api/terminal/scratch`, connect, received, headers, localInputs, remote: () => remote!, accept: () => pending!() };
}

async function refusal(ws: WebSocket) {
  return new Promise<number>((resolve, reject) => { ws.on("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode!); }); ws.on("open", () => reject(Error("unexpected upgrade"))); ws.on("error", reject); });
}

it("preserves the registry opt-in and rejects non-boolean values in both twins", async () => {
  const { validateHostRegistry: cli } = await import("../../cli/src/host-registry.js");
  for (const terminal_proxy of [true, false, "true", 1, null]) {
    const raw = { hosts: [{ id: "remote", transport: "http", url: "http://127.0.0.1:9", terminal_proxy }] };
    const d = validateHostRegistry(raw, "fixture"), c = cli(raw, "fixture");
    expect(d).toEqual(c); expect(d.ok).toBe(typeof terminal_proxy === "boolean");
    if (d.ok) expect(d.registry.hosts[0]).toHaveProperty("terminal_proxy", terminal_proxy);
  }
});

describe("remote terminal proxy admission and frames", () => {
  it("carries keys/text/scroll and output, with remote bearer only in the header and no Origin", async () => {
    const f = await fixture(); const ws = f.connect(); const output: string[] = []; ws.on("message", d => output.push(d.toString())); await once(ws, "open");
    const frames = [{ type: "keys", keys: ["Enter"] }, { type: "text", text: "literal paragraph" }, { type: "scroll", offset: 27 }];
    for (const frame of frames) ws.send(JSON.stringify(frame));
    await vi.waitFor(() => { expect(f.received.map(JSON.parse)).toEqual(frames); expect(output).toContain("remote-output"); });
    expect(f.headers).toEqual([{ url: "/api/terminal/scratch", authorization: `Bearer ${REMOTE}`, origin: undefined }]); expect(output.join("")).not.toContain(REMOTE);
  });
  it.each([undefined, "local", "self"])("keeps %s on the local path", async host => {
    const f = await fixture(); const id = host === "self" ? getSelfHostId() : host; const ws = f.connect(`?token=${LOCAL}${id ? `&host=${id}` : ""}`); await once(ws, "open"); ws.send(JSON.stringify({ type: "text", text: "local" })); await vi.waitFor(() => expect(f.localInputs).toContain("local")); expect(f.headers).toHaveLength(0);
  });
  it.each([{ query: "?host=remote", headers: {}, status: 401 }, { query: `?host=remote&token=${LOCAL}`, headers: { Origin: "https://untrusted.invalid" }, status: 403 }])("refuses local admission before any outbound dial", async ({ query, headers, status }) => {
    const f = await fixture(); expect(await refusal(f.connect(query, headers))).toBe(status); expect(f.headers).toHaveLength(0);
  });
  it.each([{ terminal_proxy: false }, { transport: "ssh", target: "fixture" }])("refuses an ineligible host without a dial: %j", async host => {
    const f = await fixture({ host }); expect(await refusal(f.connect())).toBe(403); expect(f.headers).toHaveLength(0);
  });
  it("refuses an unknown host without a dial", async () => { const f = await fixture(); expect(await refusal(f.connect(`?host=unknown&token=${LOCAL}`))).toBe(502); expect(f.headers).toHaveLength(0); });
  it("never strips remote protection when the local terminal token is absent", async () => { const f = await fixture({ localToken: null }); expect(await refusal(f.connect("?host=remote"))).toBe(403); expect(f.headers).toHaveLength(0); });
  it("turns a remote HTTP 401 into policy close 1008", async () => {
    const f = await fixture(); vi.stubEnv("PROXY_REMOTE_TOKEN", "wrong"); const ws = f.connect(); const closed = once(ws, "close"); await once(ws, "open"); expect((await closed)[0]).toBe(1008); expect(f.received).toEqual([]);
  });
  it.each([1001, 1008, 1011])("propagates remote close %s without replay", async code => {
    const f = await fixture(); const ws = f.connect(); const closed = once(ws, "close"); await vi.waitFor(() => expect(f.remote()?.readyState).toBe(WebSocket.OPEN)); f.remote().close(code, "fixture closed"); expect((await closed)[0]).toBe(code); expect(f.headers).toHaveLength(1); expect(f.received).toEqual([]);
  });
  it("closes the remote with the browser's code", async () => { const f = await fixture(); const ws = f.connect(); await vi.waitFor(() => expect(f.remote()?.readyState).toBe(WebSocket.OPEN)); const closed = once(f.remote(), "close"); ws.close(1001, "leaving"); expect((await closed)[0]).toBe(1001); });
  it.each(["frames", "bytes"])("caps early %s and forwards no input on overflow", async mode => {
    const f = await fixture({ delay: true }); const ws = f.connect(); const closed = once(ws, "close"); await once(ws, "open"); const frame = mode === "bytes" ? "x".repeat(256 * 1024 + 1) : JSON.stringify({ type: "text", text: "x" }); for (let i=0;i<(mode==="bytes"?1:33);i++) ws.send(frame); expect((await closed)[0]).toBe(1009); expect(f.received).toEqual([]);
  });
});

it("advertises terminalProxy only when the actual local WS lane is enabled and protected appropriately", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { hostsRoutes } = await import("../src/routes/hosts.js");
  const home = mkdtempSync(join(tmpdir(), "terminal-hosts-")); cleanup.push(() => rmSync(home, { recursive: true, force: true })); vi.stubEnv("OPENRIG_HOME", home);
  writeFileSync(join(home,"hosts.yaml"), JSON.stringify({ hosts: [
    {id:"opted",transport:"http",url:"http://127.0.0.1:1",terminal_proxy:true},
    {id:"protected",transport:"http",url:"http://127.0.0.1:1",terminal_proxy:true,bearer_env:"TOKEN"},
    {id:"legacy",transport:"http",url:"http://127.0.0.1:1"},
    {id:"ssh",transport:"ssh",target:"127.0.0.1",terminal_proxy:true},
  ]}));
  for (const terminalProxyEnabled of [false,true]) for (const terminalBearerToken of [null, LOCAL]) {
    const app=new Hono(); app.route("/api/hosts",hostsRoutes({terminalProxyEnabled,terminalBearerToken}));
    const response=await app.request("http://localhost/api/hosts"); expect(response.status).toBe(200); const body=await response.json();
    expect(body.hosts.map((h: {id:string;terminalProxy:boolean})=>[h.id,h.terminalProxy])).toEqual([["opted",terminalProxyEnabled],["protected",terminalProxyEnabled&&!!terminalBearerToken],["legacy",false],["ssh",false]]);
  }
});

it("returns a structured MH-3 refusal and leaves the remote composer POST forbidden", async () => {
  const f=await fixture({host:{terminal_proxy:false}});
  const response=await f.app.request("http://localhost/api/terminal/scratch?host=remote",{headers:{Upgrade:"websocket",Authorization:`Bearer ${LOCAL}`}});
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({error:"remote_terminal_refused",boundary:"MH-3",hostId:"remote"});
  const post=await f.app.request("http://localhost/api/transport/send?host=remote",{method:"POST"}); expect(post.status).toBe(405); expect(f.headers).toHaveLength(0);
});

it("drains early frames once in order after the remote handshake", async () => {
  const f=await fixture({delay:true});const ws=f.connect();await once(ws,"open");
  for(const text of ["first","second"])ws.send(JSON.stringify({type:"text",text}));
  await vi.waitFor(()=>expect(f.headers).toHaveLength(1));f.accept();
  await vi.waitFor(()=>expect(f.received.map(s=>JSON.parse(s).text)).toEqual(["first","second"]));
});
it("bounds an uncompleted remote handshake at 15 seconds and drops pending input",async()=>{
  const f=await fixture({delay:true});const ws=f.connect();const closed=once(ws,"close");await once(ws,"open");ws.send(JSON.stringify({type:"text",text:"never replay"}));expect((await closed)[0]).toBe(1011);expect(f.received).toEqual([]);expect(f.headers).toHaveLength(1);
},20000);
it("maps an abrupt remote transport loss to a legal no-reconnect close without replay",async()=>{
  const f=await fixture();const ws=f.connect();const closed=once(ws,"close");await vi.waitFor(()=>expect(f.remote()?.readyState).toBe(WebSocket.OPEN));f.remote().terminate();expect((await closed)[0]).toBe(1011);expect(f.received).toEqual([]);expect(f.headers).toHaveLength(1);
});
it("resolves missing credentials before dialing and never forwards the local token",async()=>{
  const f=await fixture();vi.stubEnv("PROXY_REMOTE_TOKEN","");expect(await refusal(f.connect())).toBe(502);expect(f.headers).toHaveLength(0);
});


it.each([WebSocket.CLOSING, WebSocket.CLOSED])("drops queued text and Enter when the browser is state %s before its close callback", async state => {
  const f = await fixture({ delay: true });
  const browser = { readyState: WebSocket.OPEN as number, send: vi.fn(), close: vi.fn() };
  const relay = remoteTerminalHandlers({ url: f.remoteUrl, token: REMOTE });
  relay.onOpen(null, browser);
  relay.onMessage({ data: JSON.stringify({ type: "text", text: "must not replay" }) });
  relay.onMessage({ data: JSON.stringify({ type: "keys", keys: ["Enter"] }) });
  await vi.waitFor(() => expect(f.headers).toHaveLength(1));
  browser.readyState = state;
  f.accept();
  await vi.waitFor(() => expect(f.remote()).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.received).toEqual([]);
  const remoteClosed = once(f.remote(), "close");
  relay.onClose({ code: 1000, reason: "viewer left" });
  expect((await remoteClosed)[0]).toBe(1000);
});
it("does not forward new input while the browser is closing before its final callback", async () => {
  const f = await fixture();
  const browser = { readyState: WebSocket.OPEN as number, send: vi.fn(), close: vi.fn() };
  const relay = remoteTerminalHandlers({ url: f.remoteUrl, token: REMOTE });
  relay.onOpen(null, browser);
  await vi.waitFor(() => expect(browser.send).toHaveBeenCalled());
  browser.readyState = WebSocket.CLOSING;
  relay.onMessage({ data: JSON.stringify({ type: "keys", keys: ["Enter"] }) });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.received).toEqual([]);
  const remoteClosed = once(f.remote(), "close");
  relay.onClose({ code: 1001, reason: "leaving" });
  expect((await remoteClosed)[0]).toBe(1001);
});
