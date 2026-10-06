import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { specsCommand, resolveLibrarySpec } from "../src/commands/specs.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";
import type { StatusDeps } from "../src/commands/status.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
it.each(["e81a4bfbead405bc", "specfile:v2:missing", "specfile:v3:unknown"])("reserved ID %s cannot fall through into an unrelated spec name", async value => {
  const client = { get: vi.fn(async () => ({ data: [{ id: "other-current-id", kind: "agent", name: value }] })) } as unknown as DaemonClient;
  await expect(resolveLibrarySpec(client, value)).rejects.toThrow(/ID|reselect/i);
});
it("exact current/workflow IDs and unambiguous names still resolve; duplicate names require choice", async () => {
  const entries = [{ id: "specfile:v2:exact", kind: "agent", name: "worker" }, { id: "workflow:exact:1", kind: "workflow", name: "flow" }]; const client = { get: vi.fn(async () => ({ data: entries })) } as unknown as DaemonClient;
  expect((await resolveLibrarySpec(client, "specfile:v2:exact")).name).toBe("worker"); expect((await resolveLibrarySpec(client, "workflow:exact:1")).name).toBe("flow"); expect((await resolveLibrarySpec(client, "worker")).id).toBe("specfile:v2:exact"); entries.push({ id: "second", kind: "agent", name: "worker" }); await expect(resolveLibrarySpec(client, "worker")).rejects.toThrow(/ambiguous/);
});
it.each(["file", "directory"])("specs add %s reports exact installed canonical source, never same-name legacy suffix", async kind => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-spec-identity-"))); dirs.push(root); const home = join(root, "home"), source = kind === "file" ? join(root, "agent.yaml") : join(root, "worker"); if (kind === "directory") mkdirSync(source); const yamlPath = kind === "file" ? source : join(source, "agent.yaml"); writeFileSync(yamlPath, "name: worker\n"); vi.stubEnv("OPENRIG_HOME", home);
  const installed = join(home, "specs", kind === "file" ? "agent.yaml" : "worker/agent.yaml"), legacy = join(root, "legacy", kind === "file" ? "agent.yaml" : "worker/agent.yaml"); mkdirSync(join(legacy, ".."), { recursive: true }); writeFileSync(legacy, "name: worker\n");
  const client = { post: vi.fn(async (route: string) => route === "/api/specs/review/rig" ? { status: 400 } : route === "/api/specs/review/agent" ? { status: 200, data: { name: "worker" } } : { status: 200, data: [{ id: "wrong-legacy-id", kind: "agent", name: "worker", sourcePath: realpathSync(legacy) }, { id: "exact-installed-id", kind: "agent", name: "worker", sourcePath: realpathSync(installed) }] }) };
  const deps = { lifecycleDeps: { exists: (path: string) => path === STATE_FILE, readFile: () => JSON.stringify({ pid: 1, port: 17499 }), isProcessAlive: () => true, fetch: async () => ({ ok: true }) }, clientFactory: () => client } as unknown as StatusDeps;
  const output: string[] = []; vi.spyOn(console, "log").mockImplementation((value: string) => output.push(value)); const previous = process.exitCode; process.exitCode = undefined;
  try { const cmd = new Command(); cmd.addCommand(specsCommand(deps)); await cmd.parseAsync(["node", "rig", "specs", "add", source, "--json"]); expect(process.exitCode).toBeUndefined(); expect(JSON.parse(output[0]!)).toMatchObject({ id: "exact-installed-id", entry: { sourcePath: realpathSync(installed) } }); } finally { process.exitCode = previous; }
});
