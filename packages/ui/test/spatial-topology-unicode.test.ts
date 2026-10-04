import { expect, it } from "vitest";
import { parseSpatialRig, spatialKey } from "../src/lib/spatial-topology.js";

const agent = (id: string) => ({ id, type: "rigNode", data: { logicalId: `seat-${id}` } });
// JSON permits escaped lone surrogates. Exercise the actual decoded wire,
// rather than assuming encodeURIComponent accepts every JSON string.
const parse = (graph: unknown) => parseSpatialRig("local", { rigId: "r", rigName: "R", graph: JSON.parse(JSON.stringify(graph)) });

it.each(["\ud800", "\udc00", "a\ud800z", "a\udc00z", "\ud800\ud800", "\ud83d\ude80\udc00"])("reports malformed node identity %# and retains valid siblings", id => {
  const rig = parse({ nodes: [agent("a"), agent(id), agent("b")], edges: [{ id: "valid", source: "a", target: "b" }] });
  expect(rig.agents.map(a => a.nodeId)).toEqual(["a", "b"]); expect(rig.edges).toHaveLength(1);
  expect(rig.issues).toMatchObject([{ kind: "malformed-node" }]);
});
it.each(["\ud800", "\udc00"])("reports malformed pod node %# without crashing its valid member", id => {
  const rig = parse({ nodes: [{ id, type: "podGroup", data: { podNamespace: "pod" } }, { ...agent("a"), parentId: id }], edges: [] });
  expect(rig.pods).toEqual([]); expect(rig.agents).toHaveLength(1); expect(rig.agents[0]?.podKey).toBeNull();
  expect(rig.issues.map(issue => issue.kind)).toEqual(["malformed-node", "orphan-parent"]);
});
it.each(["id", "source", "target"])("reports malformed edge %s and retains usable relationships", field => {
  for (const malformed of ["\ud800", "\udc00"]) {
    const rig = parse({ nodes: [agent("a"), agent("b")], edges: [
      { id: "malformed", source: "a", target: "b", [field]: malformed },
      { id: "valid", source: "a", target: "b" },
    ] });
    expect(rig.agents).toHaveLength(2); expect(rig.edges.map(edge => edge.key)).toEqual([spatialKey("local", "r", "edge", "valid")]);
    expect(rig.issues).toMatchObject([{ kind: "malformed-edge" }]);
  }
});
it("retains exact valid astral, replacement, escape-looking and accented node/edge identities without aliasing", () => {
  const ids = ["seat-\ud83d\ude80", "seat-\ufffd", "seat-%uD800", "seat-é"];
  const rig = parse({ nodes: ids.map(agent), edges: ids.map(id => ({ id, source: ids[0], target: ids[1] })) });
  expect(rig.agents.map(a => a.nodeId)).toEqual(ids);
  expect(rig.agents.map(a => a.logicalId)).toEqual(ids.map(id => `seat-${id}`));
  expect(rig.agents.map(a => a.key)).toEqual(ids.map(id => spatialKey("local", "r", "agent", id)));
  expect(rig.edges.map(e => e.key)).toEqual(ids.map(id => spatialKey("local", "r", "edge", id)));
  expect(new Set(rig.agents.map(a => a.key)).size).toBe(ids.length); expect(new Set(rig.edges.map(e => e.key)).size).toBe(ids.length);
  expect(rig.issues).toEqual([]);
});
it("retains the existing missing-edge-ID fallback for valid Unicode endpoints", () => {
  const rig = parse({ nodes: [agent("🚀"), agent("é")], edges: [{ source: "🚀", target: "é" }] });
  expect(rig.edges.map(e => e.key)).toEqual([spatialKey("local", "r", "edge", "🚀->é#0")]); expect(rig.issues).toEqual([]);
});
