// Private Files fixture: the ACTUAL daemon filesRoutes + FileWriteService
// over freshly created temporary allowlist roots. Fictional contents only;
// no user files, installed daemon, listener, browser or network. Callers
// dispose with disposeFilesFixtures() in afterEach.
import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transferableAbortController } from "node:util";
import type { ReactNode } from "react";
import { filesRoutes } from "../../daemon/src/routes/files.js";
import { FileWriteService } from "../../daemon/src/domain/files/file-write-service.js";

const owned: string[] = [];
const clients: QueryClient[] = [];

export function disposeFilesFixtures() {
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  owned.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
}

export interface FixtureRoot {
  files?: Record<string, string | Buffer>;
  /** link path -> relative symlink target */
  symlinks?: Record<string, string>;
}

export interface FetchCall { url: string; method: string; body?: unknown; status: number }

export function filesFixture(roots: Record<string, FixtureRoot>, opts: { selected?: string } = { selected: "local" }) {
  const dirs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(roots)) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `openrig-files-ui-${name}-`)));
    owned.push(dir);
    dirs[name] = dir;
    for (const [rel, bytes] of Object.entries(spec.files ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), bytes);
    }
    for (const [rel, target] of Object.entries(spec.symlinks ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      symlinkSync(target, join(dir, rel));
    }
  }
  const auditDir = realpathSync(mkdtempSync(join(tmpdir(), "openrig-files-ui-audit-")));
  owned.push(auditDir);
  const allowlist = Object.entries(dirs).map(([name, canonicalPath]) => ({ name, canonicalPath }));
  const service = new FileWriteService({ allowlist, auditFilePath: join(auditDir, "audit.jsonl") });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("filesAllowlist" as never, allowlist as never); c.set("fileWriteService" as never, service as never); await next(); });
  app.route("/api/files", filesRoutes());
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    // Bridge the jsdom AbortSignal into Node's realm instead of dropping it.
    const controller = transferableAbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const response = await app.request(`http://private.test${url}`, { ...options, signal: controller.signal });
      calls.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(String(options.body)) : undefined, status: response.status });
      return response;
    } finally { options.signal?.removeEventListener("abort", abort); }
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const setSelected = (selected: string | undefined) => {
    if (selected === undefined) client.removeQueries({ queryKey: ["hosts"], exact: true });
    else client.setQueryData(["hosts"], { ownName: "Private fixture", selected, hosts: [] });
  };
  if (opts.selected !== undefined) setSelected(opts.selected);
  const wrap = (children: ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return {
    dirs, app, fetch, calls, client, setSelected,
    path: (root: string, rel: string) => join(dirs[root]!, rel),
    writes: () => calls.filter((c) => c.method === "POST"),
    mount: (children: ReactNode) => render(wrap(children)),
    wrap,
  };
}
