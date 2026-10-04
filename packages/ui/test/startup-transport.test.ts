import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_OPERATOR_INSTANCE, operatorRead } from "../src/lib/operator-read.js";

afterEach(() => vi.unstubAllGlobals());
it("forwards explicit startup GET authorization while preserving existing GET defaults", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal("fetch", fetch);
  const valid = (v: unknown): v is { ok: true } => !!v && typeof v === "object" && "ok" in v && v.ok === true;
  await operatorRead(LOCAL_OPERATOR_INSTANCE, "/api/startup/rig", valid, { headers: { Authorization: "Bearer test-token" } } as never);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer test-token", Accept: "application/json" } });
  await operatorRead(LOCAL_OPERATOR_INSTANCE, "/api/example", valid);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET", headers: { Accept: "application/json" } });
});
