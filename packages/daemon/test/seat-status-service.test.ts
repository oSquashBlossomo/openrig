import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import { PodRepository } from "../src/domain/pod-repository.js";

describe("SeatStatusService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatStatusService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    service = new SeatStatusService({ rigRepo });
  });

  afterEach(() => {
    db.close();
  });

  it("returns honest no-handover defaults for an existing active node", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");

    const result = service.getStatus("dev-impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      current_occupant: "dev-impl@seat-rig",
      session_status: "running",
      startup_status: "ready",
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: null,
      previous_occupant: null,
      handover_at: null,
    });
  });

  it.each(["absent", "synthetic floor", "member none", "rig none", "rig none with stale auto", "legacy none over yolo", "legacy none over auto", "none with stale auto"])(
    "status route reports native inheritance for Claude %s separately from prior launch arguments", async choice => {
      const setup = createTestApp(db);
      const rig = rigRepo.createRig("permission-status");
      const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: "/private-fixture" });
      sessionRegistry.registerSession(node.id, "worker@permission-status");
      if (choice.includes("over")) {
        const posture = choice.endsWith("auto") ? "auto" : "full_bypass";
        rigRepo.setRigPermissionPolicy(rig.id, posture === "auto" ? "builtin:auto" : "builtin:yolo");
        rigRepo.setRigPolicyProvenance(rig.id, { origin: "builtin", launchPosture: posture, resolvedTarget: null, declaringDir: null });
      }
      const rigNone = choice.startsWith("rig none");
      if (choice === "synthetic floor") db.prepare("UPDATE nodes SET policy_launch_posture='floor' WHERE id=?").run(node.id);
      if (choice !== "absent" && choice !== "synthetic floor" && !rigNone) {
        db.prepare("UPDATE nodes SET permission_policy='none' WHERE id=?").run(node.id);
        if (choice === "member none" || choice === "none with stale auto") rigRepo.setNodePolicyProvenance(node.id,
          { origin: "deliberate_none", launchPosture: choice === "member none" ? "floor" : "auto", resolvedTarget: null, declaringDir: null });
      }
      if (rigNone) rigRepo.setRigPermissionPolicy(rig.id, "none");
      if (choice === "rig none with stale auto") rigRepo.setRigPolicyProvenance(rig.id,
        { origin: "deliberate_none", launchPosture: "auto", resolvedTarget: null, declaringDir: null });
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      expect(new AppliedLaunchObservationStore(db).recordGeneration(generation, observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);
      const before = db.prepare("SELECT total_changes() AS n").get();
      const response = await setup.app.request("/api/seat/status/worker%40permission-status");
      expect(response.status).toBe(200);
      const status = await response.json();
      expect(status.permissions).toMatchObject({ selectionState: "inherit", desired: null, nativeEffect: "unverified",
        effective: { effectiveMode: "inherit", launchPosture: "floor" },
        lastLaunchArguments: { value: "acceptEdits", generationUuid: generation } });
      expect(status.permissions.effective.permissionMode).toBeUndefined();
      expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    });

  it.each(["authored", "stored", "named"])("status preserves the %s Claude selection without claiming a native effect", choice => {
    const rig = rigRepo.createRig("permission-status");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    rigRepo.setNodePolicyProvenance(node.id, { origin: "builtin", launchPosture: "floor", resolvedTarget: null, declaringDir: null });
    if (choice !== "authored") new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: choice === "stored" ? "floor" : "auto" }, "operator", "selected");
    const result = service.getStatus("worker@permission-status");
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
    expect(result.status.permissions).toMatchObject({ nativeEffect: "unverified", effective: {
      effectiveMode: choice === "authored" ? "acceptEdits" : choice === "stored" ? "floor" : "auto",
      source: choice === "authored" ? "member_spec" : "explicit" } });
  });

  it("returns populated handover axes and provenance fields", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    db.prepare(`
      UPDATE nodes SET
        occupant_lifecycle = 'retired',
        continuity_outcome = 'rebuilt',
        handover_result = 'partial',
        previous_occupant = 'old-impl@seat-rig',
        handover_at = '2026-04-20T13:00:00Z'
      WHERE id = ?
    `).run(node.id);

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.occupant_lifecycle).toBe("retired");
    expect(result.status.continuity_outcome).toBe("rebuilt");
    expect(result.status.handover_result).toBe("partial");
    expect(result.status.previous_occupant).toBe("old-impl@seat-rig");
    expect(result.status.handover_at).toBe("2026-04-20T13:00:00Z");
  });

  it("does not infer active lifecycle for a node with no current running session", () => {
    const rig = rigRepo.createRig("seat-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.current_occupant).toBeNull();
    expect(result.status.occupant_lifecycle).toBe("unknown");
    expect(result.status.continuity_outcome).toBeNull();
    expect(result.status.handover_result).toBeNull();
  });

  it("resolves canonical pod coordinates for never-launched, dotted-member and stopped seats", () => {
    const rig = rigRepo.createRig("seat-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Development");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    rigRepo.addNode(rig.id, "dev.member.dot", { runtime: "terminal", podId: pod.id });
    const stopped = rigRepo.addNode(rig.id, "dev.stopped", { runtime: "terminal", podId: pod.id });
    const session = sessionRegistry.registerSession(stopped.id, "former-alias@seat-rig");
    sessionRegistry.updateStatus(session.id, "exited");

    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({
      ok: true,
      status: { logical_id: "dev.impl", current_occupant: null, occupant_lifecycle: "unknown" },
    });
    expect(service.getStatus("dev-member.dot@seat-rig")).toMatchObject({
      ok: true, status: { logical_id: "dev.member.dot" },
    });
    expect(service.getStatus("dev-stopped@seat-rig")).toMatchObject({
      ok: true, status: { logical_id: "dev.stopped", session_status: "exited" },
    });
    expect(service.getStatus("dev.impl@seat-rig")).toMatchObject({ ok: true });
    expect(service.getStatus("dev-missing@seat-rig")).toMatchObject({ ok: false, code: "seat_not_found" });

    const duplicate = rigRepo.createRig("seat-rig");
    rigRepo.addNode(duplicate.id, "dev.impl", { runtime: "terminal" });
    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({ ok: false, code: "seat_ambiguous" });
    db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), duplicate.id);
    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({ ok: true });
  });

  it("the status route resolves an adopted seat by canonical, logical and raw session references", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Development");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    setup.sessionRegistry.registerClaimedSession(node.id, "adopted-private-name");

    for (const ref of ["dev-impl@seat-rig", "dev.impl@seat-rig", "adopted-private-name"]) {
      const response = await setup.app.request(`/api/seat/status/${encodeURIComponent(ref)}`);
      expect(response.status, ref).toBe(200);
      expect(await response.json()).toMatchObject({
        logical_id: "dev.impl", current_occupant: "adopted-private-name", session_status: "running",
      });
    }
  });

  it("returns not found for an unknown seat reference", () => {
    const result = service.getStatus("missing@seat-rig");

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "List seats with: rig ps --nodes",
    });
  });

  it("wires the daemon /api/seat/status route", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/status/dev-impl%40seat-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      occupant_lifecycle: "active",
      handover_result: null,
    });
  });
});
