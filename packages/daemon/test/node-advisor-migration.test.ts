import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { nodeAdvisorModelSchema } from "../src/db/migrations/095_node_advisor_model.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

it("adds advisor to an existing fleet without changing native identities or seat configuration", () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS.filter(m => m.name !== nodeAdvisorModelSchema.name));
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = repo.createRig("migration-fixture");
    const node = repo.addNode(rig.id, "lead", { runtime: "claude-code", model: "claude-fable-5-1", effort: "high" });
    const session = registry.registerSession(node.id, "lead@migration-fixture");
    registry.updateResumeToken(session.id, "claude_id", "exact-native-conversation", "hook");
    const nodesBefore = db.prepare("SELECT * FROM nodes").all();
    const sessionsBefore = db.prepare("SELECT * FROM sessions").all();
    migrate(db, [nodeAdvisorModelSchema]);
    expect(db.prepare("SELECT * FROM nodes").all()).toEqual(nodesBefore.map(n => ({ ...(n as object), advisor_model: null })));
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(sessionsBefore);
    expect(repo.getRig(rig.id)!.nodes[0]!.advisorModel).toBeNull();
    migrate(db, [nodeAdvisorModelSchema]);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(sessionsBefore);
  } finally { db.close(); }
});
