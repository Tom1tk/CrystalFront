// Own frame (P-3): everything a v2 policy sees or targets is in the acting
// player's frame, own base on the left. Seat 0 (blue) is the world frame; seat 1
// sees the map through its symmetry transform (mirror: x → W − x; rotate: also
// y → H − y). The transform is its own inverse.
import type { MatchState } from "../../../server/src/match/types.js";
import { mapSymmetry } from "../../../server/src/match/maps.js";
import { imagePt, type Pt } from "../../../server/src/match/engine/anchors.js";

export interface Frame {
  seat: 0 | 1;
  sym: "mirror" | "rotate";
  W: number;
  H: number;
}

export function frameFor(match: MatchState, playerId: string): Frame {
  const seat = match.players[1]?.playerId === playerId ? 1 : 0;
  const sym = mapSymmetry(match.config.mapId) === "rotate" ? "rotate" : "mirror";
  return { seat, sym, W: match.config.mapWidth, H: match.config.mapHeight };
}

/** World → own frame. */
export function toOwnFrame(f: Frame, p: Pt): Pt {
  return f.seat === 0 ? { x: p.x, y: p.y } : imagePt(p, f.sym, f.W, f.H);
}

/** Own frame → world. */
export function fromOwnFrame(f: Frame, p: Pt): Pt {
  return toOwnFrame(f, p);
}

/** An own-frame offset (dx, dy) as a world offset. */
export function offsetToWorld(f: Frame, dx: number, dy: number): Pt {
  if (f.seat === 0) return { x: dx, y: dy };
  return { x: -dx, y: f.sym === "rotate" ? -dy : dy };
}
