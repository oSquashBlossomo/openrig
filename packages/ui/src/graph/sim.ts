// d3-force wiring: links pull delegation pairs together, charge keeps seats
// apart, and a cluster force holds every seat near its rig's anchor.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum } from "d3-force";
import type { GLink, GNode, GRig, Model } from "./model.js";

export type Sim = Simulation<GNode, GLink>;

export function createSim(): Sim {
  const sim = forceSimulation<GNode, GLink>([])
    // Spacing is set so a seat's label (two lines under it, ~90px wide at 1x) never overlaps a neighbour:
    // the collision radius covers the label box, and charge keeps a little air beyond that.
    .force("link", forceLink<GNode, GLink>([]).id((d) => d.id).distance((l) => (l.kind === "delegates_to" ? 96 : 140)).strength((l) => (l.kind === "delegates_to" ? 0.45 : 0.06)))
    .force("charge", forceManyBody<GNode>().strength(-360).distanceMax(520))
    .force("collide", forceCollide<GNode>(40).strength(1))
    .force("x", forceX<GNode>(0).strength(0.01))
    .force("y", forceY<GNode>(0).strength(0.01))
    .alphaDecay(0.035)
    .velocityDecay(0.35);
  sim.stop();
  return sim;
}

function clusterForce(model: Model): (alpha: number) => void {
  const anchorOf = new Map<string, GRig>();
  for (const r of model.rigs) anchorOf.set(r.rigId, r);
  return (alpha: number) => {
    for (const n of model.nodes) {
      const a = anchorOf.get(n.rigId)?.anchor;
      if (!a) continue;
      n.vx = (n.vx ?? 0) + (a.x - n.x) * 0.07 * alpha;
      n.vy = (n.vy ?? 0) + (a.y - n.y) * 0.07 * alpha;
    }
  };
}

export function applyModel(sim: Sim, model: Model): void {
  sim.nodes(model.nodes);
  (sim.force("link") as ReturnType<typeof forceLink<GNode, GLink>>).links(model.links as SimulationLinkDatum<GNode>[] as GLink[]);
  sim.force("cluster", clusterForce(model));
  sim.alpha(0.8).restart();
  sim.stop();
}

/** Same seats, new rig anchors (the stage changed shape): drift there without a full restart. */
export function reanchor(sim: Sim, model: Model): void {
  sim.force("cluster", clusterForce(model));
  sim.alpha(Math.max(sim.alpha(), 0.35));
}
