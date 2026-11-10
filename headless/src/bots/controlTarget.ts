import type { MatchState, ResourceNode } from "../../../server/src/match/types.js";
import { controlNeeded } from "../../../server/src/match/engine/control.js";
import { mapSymmetry } from "../../../server/src/match/maps.js";

/**
 * Node-control helpers for the scripted bots (G-8). Node positions and
 * controllers are public, so bots read them from the match directly.
 *
 * Orderings are symmetric between the two sides: distance from the side's own
 * crystal, tie-broken by y in the side's own frame (red's frame is y-flipped on
 * 180°-rotated maps), so mirror matches stay fair.
 */
export interface ControlView {
  slot: 0 | 1;
  /** Contested nodes, nearest to own crystal first. */
  nodes: ResourceNode[];
  /** Nodes strictly on own half (midline nodes belong to neither side). */
  own: ResourceNode[];
  held: number;
  need: number;
}

export function controlView(match: MatchState, playerId: string): ControlView {
  const slot: 0 | 1 = match.players[0]?.playerId === playerId ? 0 : 1;
  const crystal = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === playerId);
  const cx = crystal?.x ?? 0, cy = crystal?.y ?? 0;
  const flipY = slot === 1 && mapSymmetry(match.config.mapId) === "rotate";
  const H = match.config.mapHeight;
  const fy = (n: ResourceNode) => (flipY ? H - n.y : n.y);
  const d = (n: ResourceNode) => Math.round(Math.hypot(n.x - cx, n.y - cy));
  const nodes = match.resourceNodes.filter(n => n.contested)
    .sort((a, b) => d(a) - d(b) || fy(a) - fy(b));
  const mid = match.config.mapWidth / 2;
  const own = nodes.filter(n => (slot === 0 ? n.x < mid - 1 : n.x > mid + 1));
  return {
    slot, nodes, own,
    held: nodes.filter(n => n.controller === slot).length,
    need: controlNeeded(nodes.length),
  };
}

/** Nearest contested node this side doesn't hold (undefined when it holds them all). */
export function nextNode(v: ControlView): ResourceNode | undefined {
  return v.nodes.find(n => n.controller !== v.slot);
}
