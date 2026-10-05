// The test-only operator twin must answer like the served daemon routes, or
// browser checks against it would show filter controls that change nothing.
// Contract: packages/daemon/src/routes/health.ts + HealthProjectionService.list
// and routes/queue.ts `/human-updates`.

import { describe, expect, it } from "vitest";
import type { HealthListProjection } from "../src/hooks/useCanonicalHealth.js";
import { readCanonicalHealth } from "../src/hooks/useCanonicalHealth.js";
import { LOCAL_OPERATOR_INSTANCE } from "../src/lib/operator-read.js";
import { operatorTwinBody, twinDeliveredUpdatesFor, twinHealthListFor, twinHealthList, twinHealthRecords } from "../twin/operator-fixtures.js";
import { vi } from "vitest";

const list = (query: string) => {
  const served = twinHealthListFor(new URLSearchParams(query));
  return { status: served.status, body: served.body as HealthListProjection & { error?: string } };
};

describe("operator twin · /api/health", () => {
  it("omits cleared findings by default and serves them only for status=cleared", () => {
    expect(list("").body.records.map((r) => r.id)).toEqual(["hf-queue-stall-builder2", "hf-context-reviewer1"]);
    expect(list("status=cleared").body.records.map((r) => r.id)).toEqual(["hf-rig-restore-gamma"]);
  });

  it("applies severity, status and paired terminal-ID scope filters", () => {
    expect(list("severity=critical").body.records.map((r) => r.id)).toEqual(["hf-queue-stall-builder2"]);
    expect(list("status=indeterminate").body.records.map((r) => r.id)).toEqual(["hf-context-reviewer1"]);
    expect(list("scope_type=seat&scope_id=node_reviewer1").body.records.map((r) => r.id)).toEqual(["hf-context-reviewer1"]);
    // Composite or rig IDs do not match a seat scope.
    expect(list("scope_type=seat&scope_id=rig_alpha").body.total).toBe(0);
    expect(list("scope_type=rig&scope_id=rig_gamma&status=cleared").body.records.map((r) => r.id)).toEqual(["hf-rig-restore-gamma"]);
  });

  it("bounds by limit with total/truncated over the filtered set, keeping whole-evaluation coverage", () => {
    const one = list("limit=1").body;
    expect(one).toMatchObject({ limit: 1, total: 2, truncated: true });
    expect(one.records).toHaveLength(1);
    expect(one.coverage).toEqual(twinHealthList.coverage);
    expect(list("").body.limit).toBe(100);
    expect(list("severity=info").body.evaluatedAt).toBe(twinHealthRecords[0]!.freshness.evaluatedAt);
  });

  it("rejects malformed filters like the daemon route", () => {
    expect(list("scope_type=seat").status).toBe(400);
    expect(list("scope_type=pod&scope_id=x").status).toBe(400);
    expect(list("severity=fatal").status).toBe(400);
    expect(list("status=open").status).toBe(400);
    expect(list("limit=0").status).toBe(400);
    expect(list("limit=201").status).toBe(400);
  });

  it("serves exact finding detail or a 404", () => {
    expect(operatorTwinBody("/api/health/hf-context-reviewer1", new URLSearchParams())?.status).toBe(200);
    expect(operatorTwinBody("/api/health/hf-context", new URLSearchParams())?.status).toBe(404);
  });

  it("is accepted by the actual canonical reader, filters included", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://local");
      const served = operatorTwinBody(url.pathname, url.searchParams)!;
      return Response.json(served.body, { status: served.status });
    }));
    try {
      const read = await readCanonicalHealth(LOCAL_OPERATOR_INSTANCE, { scopeType: "seat", scopeId: "node_builder2" });
      expect(read.records.map((r) => r.id)).toEqual(["hf-queue-stall-builder2"]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("operator twin · /api/queue/human-updates", () => {
  it("bounds by limit and reports truncation", () => {
    expect(twinDeliveredUpdatesFor(new URLSearchParams("limit=1")).body).toMatchObject({ limit: 1, truncated: true });
    expect(twinDeliveredUpdatesFor(new URLSearchParams()).body).toMatchObject({ limit: 20, truncated: false });
    expect(twinDeliveredUpdatesFor(new URLSearchParams("limit=101")).status).toBe(400);
  });
});
