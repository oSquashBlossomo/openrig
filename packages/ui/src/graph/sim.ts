// d3-force wiring: links pull delegation pairs together, charge keeps seats
// apart, and a cluster force holds every seat near its rig's anchor.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum } from "d3-force";
import type { GLink, GNode, GRig, Model } from "./model.js";

export type Sim = Simulation<GNode, GLink>;

export function createSim(): Sim {
  const sim = forceSimulation<GNode, GLink>([])
    .force("link", forceLink<GNode, GLink>([]).id((d) => d.id).distance((l) => (l.kind === "delegates_to" ? 70 : 110)).strength((l) => (l.kind === "delegates_to" ? 0.5 : 0.08)))
    .force("charge", forceManyBody<GNode>().strength(-240).distanceMax(420))
    .force("collide", forceCollide<GNode>(22).strength(0.9))
    .force("x", forceX<GNode>(0).strength(0.01))
    .force("y", forceY<GNode>(0).strength(0.01))
    .alphaDecay(0.035)
    .velocityDecay(0.35);
  sim.stop();
  return sim;
}

export function applyModel(sim: Sim, model: Model): void {
  const anchorOf = new Map<string, GRig>();
  for (const r of model.rigs) anchorOf.set(r.rigId, r);
  sim.nodes(model.nodes);
  (sim.force("link") as ReturnType<typeof forceLink<GNode, GLink>>).links(model.links as SimulationLinkDatum<GNode>[] as GLink[]);
  sim.force("cluster", (alpha: number) => {
    for (const n of model.nodes) {
      const a = anchorOf.get(n.rigId)?.anchor;
      if (!a) continue;
      n.vx = (n.vx ?? 0) + (a.x - n.x) * 0.09 * alpha;
      n.vy = (n.vy ?? 0) + (a.y - n.y) * 0.09 * alpha;
    }
  });
  sim.alpha(0.8).restart();
  sim.stop();
}
