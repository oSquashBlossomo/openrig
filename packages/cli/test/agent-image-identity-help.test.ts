import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { agentImageCommand } from "../src/commands/agent-image.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { DaemonClient } from "../src/client.js";
afterEach(() => vi.restoreAllMocks());
it("ambiguous names direct the operator to an exact listed ID rather than concatenating a tuple", async () => {
  const client = { get: vi.fn(async () => ({ status: 200, data: [
    { id: "fictional-first", name: "worker:one", version: "2" },
    { id: "fictional-second", name: "worker:one", version: "one:2" },
  ] })) } as unknown as DaemonClient;
  const deps: StatusDeps = { lifecycleDeps: {
    spawn: vi.fn(() => { throw new Error("Unexpected daemon launch"); }),
    kill: vi.fn(() => false), writeFile: vi.fn(), removeFile: vi.fn(),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3),
    exists: (path: string) => path === STATE_FILE,
    readFile: (path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 12345, db: "private", startedAt: "2026-01-01" }) : null,
    isProcessAlive: () => true, fetch: async () => ({ ok: true }),
  }, clientFactory: () => client };
  const error = vi.spyOn(console, "error").mockImplementation(() => {}), previous = process.exitCode;
  try {
    const command = new Command().exitOverride().addCommand(agentImageCommand(deps));
    await command.parseAsync(["node", "rig", "agent-image", "show", "worker:one"]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("rig agent-image list --json");
    expect(error.mock.calls[0]?.[0]).toMatch(/exact.*id/i);
    expect(error.mock.calls[0]?.[0]).not.toContain("agent-image:worker:one:<version>");
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/agent-images/library");
  } finally { process.exitCode = previous; }
});
