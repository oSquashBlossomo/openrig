// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostsRoutes } from "../../daemon/src/routes/hosts.js";
import { readHosts } from "../src/lib/hosts-read.js";

// Exercise the route's real registry projection, with no socket or network.
vi.mock("node:net", async importOriginal => {
  const original = await importOriginal<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  const connect = vi.fn(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  return { ...original, connect, default: { ...original.default, connect } };
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it("retains actual host selection and pointer facts, including a removed alias", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-host-contract-")));
  roots.push(root); vi.stubEnv("OPENRIG_HOME", root);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "host.selected" ? "removed-alias" : "Own daemon" }) } as never);
    await next();
  });
  app.route("/api/hosts", hostsRoutes());
  vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => app.request(route, options)));
  // A missing private registry is a valid empty list, not missing selection.
  expect(await readHosts()).toEqual({ selected: "removed-alias", ownName: "Own daemon", hosts: [] });
  writeFileSync(join(root, "hosts.yaml"), `hosts:
  - id: public-http
    transport: http
    url: http://private.invalid
  - id: credential-http
    transport: http
    url: https://private.invalid
    hostId: host-11111111
    bearer_file: /private/inert-pointer
    notes: exact pointer facts
  - id: ssh-alias
    transport: ssh
    target: private.invalid
    user: operator
`);
  const data = await readHosts();
  expect(data).toMatchObject({ selected: "removed-alias", ownName: "Own daemon" });
  expect(data.hosts).toHaveLength(3);
  expect(data.hosts.every(host => host.selected === false && host.status === "reachable")).toBe(true);
  expect(data.hosts[0]).not.toHaveProperty("bearer_file");
  expect(data.hosts[0]).not.toHaveProperty("bearer_env");
  expect(data.hosts[1]).toMatchObject({ hostId: "host-11111111", bearer_file: "/private/inert-pointer", notes: "exact pointer facts" });
  expect(data.hosts[2]).toHaveProperty("user", "operator");
  writeFileSync(join(root, "hosts.yaml"), "hosts:\n  - id: invalid-pointer\n    transport: http\n    url: http://private.invalid\n    bearer_file: null\n");
  await expect(readHosts()).rejects.toMatchObject({ code: "http", status: 500, serverCode: "invalid_registry" });
});
