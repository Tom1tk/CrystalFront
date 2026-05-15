import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Lobby, Player, MatchState, ResourceNodeDisplay, BuildingType, MatchEntity } from "../types";
import { FCT, FctMark, FctStat, FctStyles, DbgBtn, HEX_CLIP, NOTCH_R } from "../design/facet";
import { UNIT_DEFS, BUILDING_DEFS } from "@crystalfront/shared";

interface GameShellProps {
  lobby: Lobby | null;
  player: Player | null;
  matchState: MatchState | null;
  resourceNodes: ResourceNodeDisplay[];
  onDebugWin: (winner: "player1" | "player2") => void;
  onDebugSpawn: (entityType: string, x: number, y: number, buildingType?: string) => void;
  onGameCommand: (command: {
    type: string;
    entityId?: string;
    buildingId?: string;
    entityIds?: string[];
    workerIds?: string[];
    targetX?: number;
    targetY?: number;
    targetEntityId?: string;
    buildingType?: BuildingType;
  }) => void;
  error: string | null;
  onClearError: () => void;
  isReplay?: boolean;
  onStopReplay?: () => void;
  replayTotalTicks?: number;
  replayVersion?: string;
  gameVersion?: string;
}

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
const MINIMAP_WIDTH = 450;
const MINIMAP_HEIGHT = 120;
const EDGE_SCROLL_THRESHOLD = 50;
const EDGE_SCROLL_SPEED = 3;

const BUILDING_COLORS: Record<BuildingType, string> = {
  barracks: "#3aa8c8",
  foundry: "#ff5cf3",
  supply_depot: "#7cffb0",
  turret: "#ffb86b",
};

const BUILDING_LABELS: Record<BuildingType, string> = {
  barracks: "BRK",
  foundry: "FRY",
  supply_depot: "SUP",
  turret: "TRT",
};

const BUILDING_UNIT_MAP: Record<BuildingType, string[]> = {
  barracks: ["skirmisher", "gunner"],
  foundry: ["bruiser", "medic"],
  supply_depot: [],
  turret: [],
};

const BUILDING_COSTS: Record<BuildingType, number> = {
  barracks: 75,
  foundry: 100,
  supply_depot: 50,
  turret: 60,
};

const BUILDING_SIZES: Record<BuildingType, { w: number; h: number }> = {
  barracks: { w: 40, h: 40 },
  foundry: { w: 44, h: 44 },
  supply_depot: { w: 36, h: 36 },
  turret: { w: 30, h: 30 },
};

const UNIT_COSTS: Record<string, { cost: number; supplyCost: number }> = {
  skirmisher: { cost: 50, supplyCost: 1 },
  gunner: { cost: 75, supplyCost: 1 },
  bruiser: { cost: 100, supplyCost: 2 },
  medic: { cost: 60, supplyCost: 1 },
};

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  mapWidth: number,
  mapHeight: number,
  cameraX: number,
  cameraWidth: number,
  resourceNodes: ResourceNodeDisplay[],
  entities: { id: string; type: string; ownerId: string; x: number; y: number; radius: number; color: string; buildingType?: string }[],
  playerColor: "blue" | "red",
  minimapX: number,
  minimapY: number
) {
  const mmW = MINIMAP_WIDTH;
  const mmH = MINIMAP_HEIGHT;
  const xScale = mmW / mapWidth;
  const yScale = mmH / mapHeight;

  ctx.fillStyle = "rgba(0, 0, 12, 0.88)";
  ctx.fillRect(minimapX, minimapY, mmW, mmH);

  ctx.strokeStyle = "rgba(100, 100, 200, 0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(minimapX, minimapY, mmW, mmH);

  for (const node of resourceNodes) {
    const nx = minimapX + node.x * xScale;
    const ny = minimapY + (node.y / mapHeight) * mmH;
    const depletion = node.remaining / node.capacity;
    ctx.fillStyle = `rgba(204, 170, 68, ${0.3 + depletion * 0.7})`;
    ctx.fillRect(nx - 1, ny - 1, 2, 2);
  }

  for (const entity of entities) {
    if (entity.type === "resource_node" || entity.type === "placeholder") continue;
    const ex = minimapX + entity.x * xScale;
    const ey = minimapY + (entity.y / mapHeight) * mmH;
    const color = entity.type === "crystal"
      ? (entity.ownerId === undefined ? "#888" : playerColor === "blue" ? "#7ce8ff" : "#ff5cf3")
      : entity.color;
    ctx.fillStyle = color;
    ctx.fillRect(ex - 1, ey - 1, 2, 2);
  }

  const vpX = minimapX + cameraX * xScale;
  const vpW = Math.max(2, cameraWidth * xScale);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 1;
  ctx.strokeRect(vpX, minimapY, vpW, mmH);
}

const UNIT_RANGES: Record<string, number> = {
  skirmisher: 20,
  gunner: 120,
  bruiser: 20,
  medic: 80,
  worker: 15,
};

const UNIT_COOLDOWNS: Record<string, number> = {
  skirmisher: 10,
  gunner: 15,
  bruiser: 8,
  medic: 25,
  worker: 20,
  building: 12,
};

function getAttackCooldownTicks(type: string): number {
  return UNIT_COOLDOWNS[type] ?? 20;
}

function drawAttackLines(
  ctx: CanvasRenderingContext2D,
  entities: MatchEntity[],
  matchState: MatchState
) {
  const tickIntervalMs = matchState.tickIntervalMs ?? 100;
  const currentTick = matchState.tick;
  const now = matchState.stateTimestamp ?? Date.now();

  // Blue queued attack lines (out of range, chasing target)
  for (const entity of entities) {
    if (!entity.attackTargetId) continue;
    if (entity.type === "crystal") continue;
    const target = entities.find((e) => e.id === entity.attackTargetId);
    if (!target) continue;
    const range = entity.type === "building"
      ? (entity.buildingType === "turret" ? 150 : 0)
      : (UNIT_RANGES[entity.type as keyof typeof UNIT_RANGES] ?? 20);
    const dx = target.x - entity.x;
    const dy = target.y - entity.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= range) continue;

    const mx = (entity.x + target.x) / 2;
    const my = (entity.y + target.y) / 2;
    const angle = Math.atan2(dy, dx);

    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y);
    ctx.lineTo(target.x, target.y);
    ctx.strokeStyle = "rgba(100,150,255,0.45)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fillStyle = "rgba(100,150,255,0.5)";
    ctx.fill();
    ctx.restore();
  }

  // Red/Green landed attack/heal lines from attackLog
  const attackLog = matchState.attackLog ?? [];
  for (const evt of attackLog) {
    const attacker = entities.find((e) => e.id === evt.attackerId);
    const target = entities.find((e) => e.id === evt.targetId);
    if (!attacker || !target) continue;

    const cooldownTicks = getAttackCooldownTicks(attacker.type);
    const displayMs = (cooldownTicks * tickIntervalMs) / 2;
    const elapsed = (now - (matchState.stateTimestamp ?? now)) + (currentTick - evt.tick) * tickIntervalMs;
    if (elapsed > displayMs) continue;

    const alpha = Math.max(0, 1 - elapsed / displayMs);
    const mx = (attacker.x + target.x) / 2;
    const my = (attacker.y + target.y) / 2;
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const angle = Math.atan2(dy, dx);

    const color = evt.isHeal
      ? `rgba(80,255,80,${(0.7 * alpha).toFixed(2)})`
      : `rgba(255,70,70,${(0.7 * alpha).toFixed(2)})`;

    ctx.beginPath();
    ctx.moveTo(attacker.x, attacker.y);
    ctx.lineTo(target.x, target.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
}

const GATHER_RANGE = 60;

function drawConstructionLines(
  ctx: CanvasRenderingContext2D,
  entities: MatchEntity[]
) {
  for (const entity of entities) {
    if (entity.type !== "worker" || !entity.buildTargetId) continue;
    const target = entities.find((e) => e.id === entity.buildTargetId);
    if (!target) continue;
    const dx = target.x - entity.x;
    const dy = target.y - entity.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const mx = (entity.x + target.x) / 2;
    const my = (entity.y + target.y) / 2;
    const angle = Math.atan2(dy, dx);

    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y);
    ctx.lineTo(target.x, target.y);

    if (dist <= GATHER_RANGE) {
      ctx.strokeStyle = "rgba(100,255,150,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
    } else {
      ctx.strokeStyle = "rgba(100,255,150,0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (dist > GATHER_RANGE) {
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-4, -4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fillStyle = "rgba(100,255,150,0.5)";
      ctx.fill();
      ctx.restore();
    }
  }
}

function drawGatherLines(
  ctx: CanvasRenderingContext2D,
  entities: MatchEntity[],
  resourceNodes: ResourceNodeDisplay[]
) {
  for (const entity of entities) {
    if (entity.type !== "worker" || !entity.gatheringNodeId) continue;
    const node = resourceNodes.find((n) => n.id === entity.gatheringNodeId);
    if (!node) continue;
    const dx = node.x - entity.x;
    const dy = node.y - entity.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const mx = (entity.x + node.x) / 2;
    const my = (entity.y + node.y) / 2;
    const angle = Math.atan2(dy, dx);

    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y);
    ctx.lineTo(node.x, node.y);

    if (dist <= GATHER_RANGE) {
      ctx.strokeStyle = "rgba(255,255,100,0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
    } else {
      ctx.strokeStyle = "rgba(255,200,50,0.5)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (dist > GATHER_RANGE) {
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-4, -4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,200,50,0.5)";
      ctx.fill();
      ctx.restore();
    }
  }
}

// ─── FACET SILHOUETTE CANVAS DRAWING ──────────────────────────
// Colours: ice (#7ce8ff) friendly / magenta (#ff5cf3) enemy.

const SIL_FILL_FRIENDLY = "#7ce8ff";
const SIL_STROKE_FRIENDLY = "rgba(124,232,255,0.85)";
const SIL_FILL_ENEMY = "#ff5cf3";
const SIL_STROKE_ENEMY = "rgba(255,140,240,0.85)";
const SIL_WASH_FRIENDLY = "rgba(124,232,255,0.15)";
const SIL_WASH_ENEMY = "rgba(255,92,243,0.15)";

function silColors(isMyTeam: boolean) {
  return {
    fill: isMyTeam ? SIL_FILL_FRIENDLY : SIL_FILL_ENEMY,
    stroke: isMyTeam ? SIL_STROKE_FRIENDLY : SIL_STROKE_ENEMY,
    wash: isMyTeam ? SIL_WASH_FRIENDLY : SIL_WASH_ENEMY,
    ink: isMyTeam ? "#001321" : "#1a0014",
  };
}

function drawCrystal(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, pulseA: number) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  // outer aura
  ctx.beginPath();
  ctx.moveTo(0, -30); ctx.lineTo(22, -10); ctx.lineTo(17, 22); ctx.lineTo(-17, 22); ctx.lineTo(-22, -10); ctx.closePath();
  ctx.fillStyle = c.wash.replace("0.15", pulseA.toFixed(2));
  ctx.fill();
  // main gem body
  ctx.beginPath();
  ctx.moveTo(0, -22); ctx.lineTo(18, -8); ctx.lineTo(14, 18); ctx.lineTo(-14, 18); ctx.lineTo(-18, -8); ctx.closePath();
  ctx.fillStyle = c.fill;
  ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  // top highlight facet
  ctx.beginPath();
  ctx.moveTo(0, -22); ctx.lineTo(9, -4); ctx.lineTo(-9, -4); ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.fill();
  // internal facet lines
  ctx.strokeStyle = c.ink; ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.moveTo(-18, -8); ctx.lineTo(18, -8); ctx.stroke();
  ctx.globalAlpha = 0.45;
  ctx.beginPath(); ctx.moveTo(0, -22); ctx.lineTo(0, 18); ctx.stroke();
  ctx.globalAlpha = 0.4;
  ctx.beginPath(); ctx.moveTo(-14, 18); ctx.lineTo(0, -4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(14, 18); ctx.lineTo(0, -4); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawBarracks(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  // main body
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.rect(-20, -14, 40, 34); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  // crenellations
  ctx.fillStyle = c.fill;
  ctx.fillRect(-20, -20, 8, 6);
  ctx.fillRect(-4, -20, 8, 6);
  ctx.fillRect(12, -20, 8, 6);
  // door arch
  ctx.fillStyle = c.ink; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.moveTo(-7, 20); ctx.lineTo(-7, 4); ctx.quadraticCurveTo(0, -3, 7, 4); ctx.lineTo(7, 20); ctx.closePath();
  ctx.fill();
  // stripe
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(-20, 2); ctx.lineTo(20, 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawFoundry(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, furnaceAlpha: number) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  // chimney
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.rect(8, -22, 8, 14); ctx.fill(); ctx.stroke();
  // pentagon body
  ctx.globalAlpha = 0.92;
  ctx.beginPath(); ctx.moveTo(-22, -6); ctx.lineTo(0, -22); ctx.lineTo(22, -6); ctx.lineTo(22, 22); ctx.lineTo(-22, 22); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  // furnace mouth
  ctx.beginPath(); ctx.arc(0, 8, 7, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,184,107,${(0.7 + 0.3 * furnaceAlpha).toFixed(2)})`;
  ctx.fill();
  ctx.beginPath(); ctx.arc(0, 8, 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${(0.55 + 0.2 * furnaceAlpha).toFixed(2)})`;
  ctx.fill();
  // ridge line
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(-22, -6); ctx.lineTo(22, -6); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawDepot(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
  // two stacked containers
  ctx.beginPath(); ctx.rect(-18, -18, 36, 18); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.rect(-18, 0, 36, 18); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  // ribbing
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
  for (let v = -9; v <= 9; v += 9) {
    ctx.beginPath(); ctx.moveTo(v, -15); ctx.lineTo(v, -3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(v, 3); ctx.lineTo(v, 15); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawTurret(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, angle: number) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  // base footprint
  ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fillStyle = c.wash; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  // turret head + barrel
  ctx.save();
  ctx.rotate((angle * Math.PI) / 180);
  ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 1;
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.rect(-2, -22, 4, 14);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 1;
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = c.ink;
  ctx.fillRect(-3, -24, 6, 3);
  ctx.restore();
  ctx.restore();
}

function drawWorker(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, selected: boolean) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,68,0.7)"; ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  // conical cartoon drill — centered, downward-pointing
  ctx.fillStyle = c.ink; ctx.globalAlpha = 0.75;
  // cone body
  ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(0, 8); ctx.lineTo(5, -3); ctx.closePath();
  ctx.fill();
  // drill ridges (horizontal bands)
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(-3, 0, 6, 1.5);
  ctx.fillRect(-1.5, 3, 3, 1.5);
  // cone tip highlight
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(-1, 4); ctx.lineTo(0, 4); ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawSkirmisher(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, selected: boolean, facing: string) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,68,0.7)"; ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (facing === "l") ctx.scale(-1, 1);
  ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, 9); ctx.lineTo(-7, -9); ctx.closePath();
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawGunner(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, selected: boolean, facing: string) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,68,0.7)"; ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (facing === "l") ctx.scale(-1, 1);
  ctx.beginPath(); ctx.rect(-9, -7, 14, 14);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.rect(5, -2, 6, 4);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 1;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawBruiser(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, selected: boolean) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,68,0.7)"; ctx.lineWidth = 2;
    ctx.stroke();
  }
  // outer octagon
  ctx.beginPath();
  ctx.moveTo(-14, -5); ctx.lineTo(-8, -12); ctx.lineTo(8, -12); ctx.lineTo(14, -5);
  ctx.lineTo(14, 5); ctx.lineTo(8, 12); ctx.lineTo(-8, 12); ctx.lineTo(-14, 5); ctx.closePath();
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  // inner octagon
  ctx.beginPath();
  ctx.moveTo(-6, -3); ctx.lineTo(-3, -6); ctx.lineTo(3, -6); ctx.lineTo(6, -3);
  ctx.lineTo(6, 3); ctx.lineTo(3, 6); ctx.lineTo(-3, 6); ctx.lineTo(-6, 3); ctx.closePath();
  ctx.fillStyle = c.ink; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();
}

function drawMedic(ctx: CanvasRenderingContext2D, x: number, y: number, isMyTeam: boolean, selected: boolean) {
  const c = silColors(isMyTeam);
  ctx.save();
  ctx.translate(x, y);
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,68,0.7)"; ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fillStyle = c.fill; ctx.strokeStyle = c.stroke; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = c.ink;
  ctx.fillRect(-2, -7, 4, 14);
  ctx.fillRect(-7, -2, 14, 4);
  ctx.restore();
}

export default function GameShell({
  lobby,
  player,
  matchState,
  resourceNodes,
  onDebugWin,
  onDebugSpawn,
  onGameCommand,
  error,
  onClearError,
  isReplay = false,
  onStopReplay,
  replayTotalTicks,
  replayVersion,
  gameVersion,
}: GameShellProps) {
  // Callers always provide player (even replay passes a synthetic observer object).
  // The null type on the prop exists so replay can pass `null`-ish defaults,
  // but we normalise here to avoid TS18047 errors throughout.
  const safePlayer = player ?? { id: "__observer__", username: "Replay", color: "blue" as const, ready: false, score: 0 };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [buildMode, setBuildMode] = useState(false);
  const [selectedBuildingType, setSelectedBuildingType] = useState<BuildingType | null>(null);
  const [showUnitQueue, setShowUnitQueue] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [debugSpawnMode, setDebugSpawnMode] = useState<string | null>(null);
  const [rallyMode, setRallyMode] = useState<{ buildingId: string } | null>(null);
  const [debugDragMode, setDebugDragMode] = useState(false);
  const [debugCollapsed, setDebugCollapsed] = useState(true);
  const [debugDraggingNodeId, setDebugDraggingNodeId] = useState<string | null>(null);
  const debugDragLastSendRef = useRef(0);

  // Hotkey menu state - QWER/ASDF grid (context-aware)
  type HotkeyAction =
    | "train_worker"
    | "train_skirmisher"
    | "train_gunner"
    | "train_bruiser"
    | "train_medic"
    | "build_supply_depot"
    | "build_barracks"
    | "build_foundry"
    | "build_turret"
    | "toggle_auto_attack"
    | "unit_stop"
    | "retreat"
    | "fortify"
    | "set_rally"
    | "none";

  type HotkeySlot = { key: string; action: HotkeyAction; label: string; icon: string };

  // Context-aware hotkey computation
  const hotkeys = useMemo((): HotkeySlot[] => {
    const allSelected = Array.from(selectedEntityIds);
    if (allSelected.length === 0) {
      return [
        { key: "q", action: "none", label: "", icon: "" },
        { key: "w", action: "none", label: "", icon: "" },
        { key: "e", action: "none", label: "", icon: "" },
        { key: "r", action: "none", label: "", icon: "" },
        { key: "a", action: "none", label: "", icon: "" },
        { key: "s", action: "none", label: "", icon: "" },
        { key: "d", action: "none", label: "", icon: "" },
        { key: "f", action: "none", label: "", icon: "" },
      ];
    }

    const selectedEntities = allSelected
      .map((id) => matchState?.entities.find((ent) => ent.id === id))
      .filter((e): e is MatchEntity => e != null);

    const crystalSelected = selectedEntities.some(
      (e) => e.type === "crystal" && e.ownerId === safePlayer.id
    );
    const barracksSelected = selectedEntities.some(
      (e) => e.type === "building" && e.buildingType === "barracks" && e.ownerId === safePlayer.id
    );
    const foundrySelected = selectedEntities.some(
      (e) => e.type === "building" && e.buildingType === "foundry" && e.ownerId === safePlayer.id
    );
    const hasWorkers = selectedEntities.some(
      (e) => e.type === "worker" && e.ownerId === safePlayer.id
    );
    const hasCombatUnits = selectedEntities.some(
      (e) => e.type !== "building" && e.type !== "crystal" && e.type !== "worker" && e.ownerId === safePlayer.id
    );

    // Workers → building hotkeys (QWER), non-worker units → combat hotkeys (ASDF)
    // Rally point (F) available when any production building is selected
    const hasProductionBuilding = selectedEntities.some(
      (e) => e.type === "building" && (e.buildingType === "barracks" || e.buildingType === "foundry") && e.ownerId === safePlayer.id
    );

    if (hasWorkers) {
      return [
        { key: "q", action: "build_supply_depot", label: "Supply Depot (50)", icon: "📦" },
        { key: "w", action: "build_barracks", label: "Barracks (75)", icon: "🏰" },
        { key: "e", action: "build_foundry", label: "Foundry (100)", icon: "🏭" },
        { key: "r", action: "build_turret", label: "Turret (60)", icon: "🔫" },
        { key: "a", action: "none", label: "", icon: "" },
        { key: "s", action: "none", label: "", icon: "" },
        { key: "d", action: "none", label: "", icon: "" },
        { key: "f", action: "none", label: "", icon: "" },
      ];
    }

    return [
      { key: "q", action: crystalSelected ? "train_worker" : barracksSelected ? "train_skirmisher" : "none", label: crystalSelected ? "Worker (25)" : barracksSelected ? "Skirmisher (50)" : "", icon: crystalSelected ? "👷" : barracksSelected ? "⚔️" : "" },
      { key: "w", action: barracksSelected ? "train_gunner" : "none", label: barracksSelected ? "Gunner (75)" : "", icon: barracksSelected ? "🔫" : "" },
      { key: "e", action: foundrySelected ? "train_bruiser" : "none", label: foundrySelected ? "Bruiser (100)" : "", icon: foundrySelected ? "🛡️" : "" },
      { key: "r", action: foundrySelected ? "train_medic" : "none", label: foundrySelected ? "Medic (60)" : "", icon: foundrySelected ? "💊" : "" },
      { key: "a", action: hasCombatUnits ? "toggle_auto_attack" : "none", label: hasCombatUnits ? "Attack" : "", icon: hasCombatUnits ? "⚔️" : "" },
      { key: "s", action: hasCombatUnits ? "unit_stop" : "none", label: hasCombatUnits ? "Stop" : "", icon: hasCombatUnits ? "⏹" : "" },
      { key: "d", action: hasCombatUnits ? "retreat" : "none", label: hasCombatUnits ? "Retreat" : "", icon: hasCombatUnits ? "↩️" : "" },
      { key: "f", action: hasProductionBuilding ? "set_rally" : "none", label: hasProductionBuilding ? "Rally" : "", icon: hasProductionBuilding ? "🚩" : "" },
    ];
  }, [selectedEntityIds, matchState, safePlayer.id]);

  const [showHotkeyMenu, setShowHotkeyMenu] = useState(true);
  const [hotkeyFlash, setHotkeyFlash] = useState<string | null>(null);

  const dprRef = useRef(window.devicePixelRatio || 1);
  const cameraXRef = useRef(0);
  const cameraYRef = useRef(0);
  const cameraInitializedRef = useRef(false);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const matchStateRef = useRef<MatchState | null>(null);
  matchStateRef.current = matchState;

  // Interpolation state
  const prevEntitiesRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const oldPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevTimestampRef = useRef<number>(0);
  const lastTickRef = useRef<number>(-1);
  const resourceNodesRef = useRef<ResourceNodeDisplay[]>(resourceNodes);
  const selectedEntityIdRef = useRef<string | null>(selectedEntityId);
  const selectedEntityIdsRef = useRef<Set<string>>(selectedEntityIds);
  const hoverPosRef = useRef<{ x: number; y: number } | null>(hoverPos);
  const buildModeRef = useRef(buildMode);
  const selectedBuildingTypeRef = useRef<BuildingType | null>(selectedBuildingType);
  const isDraggingRef = useRef(isDragging);
  const dragStartRef = useRef<{ x: number; y: number } | null>(dragStart);
  const debugSpawnModeRef = useRef<string | null>(null);
  const playerRef = useRef(safePlayer);
  const minimapDraggingRef = useRef(false);

  // Death particle system
  const prevEntityIdsRef = useRef<Set<string>>(new Set());
  const prevEntityHealthRef = useRef<Map<string, number>>(new Map());
  const particlesRef = useRef<Array<{
    x: number; y: number; vx: number; vy: number;
    life: number; maxLife: number; color: string; size: number
  }>>([]);

  useEffect(() => {
    resourceNodesRef.current = resourceNodes;
    selectedEntityIdRef.current = selectedEntityId;
    selectedEntityIdsRef.current = selectedEntityIds;
    hoverPosRef.current = hoverPos;
    buildModeRef.current = buildMode;
    selectedBuildingTypeRef.current = selectedBuildingType;
    isDraggingRef.current = isDragging;
    dragStartRef.current = dragStart;
    debugSpawnModeRef.current = debugSpawnMode;
  });

  const isMyEntity = useCallback(
    (entity: { ownerId: string }) => entity.ownerId === safePlayer.id,
    [safePlayer.id]
  );

  const myEntities = matchState?.entities.filter(isMyEntity) ?? [];
  const myCrystal = myEntities.find((e) => e.type === "crystal");

  // Reset camera guard when leaving a match so the next match re-initialises
  useEffect(() => {
    if (!matchState) {
      cameraInitializedRef.current = false;
    }
  }, [matchState]);

  // Initialise camera only once per match
  useEffect(() => {
    if (!matchState || cameraInitializedRef.current) return;
    cameraInitializedRef.current = true;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Use container dimensions — they're set by CSS flexbox during layout,
    // before effects run. canvas.clientHeight is 0/default until ResizeObserver fires later.
    const viewW = container.clientWidth;
    const viewH = container.clientHeight;
    const mapWidth = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
    const mapHeight = matchState.mapHeight ?? matchState.config?.mapHeight ?? 600;

    const myIdx = matchState.players.findIndex((p) => p?.playerId === safePlayer.id);
    const myCrystal = matchState.entities.find((e) => e.type === "crystal" && e.ownerId === safePlayer.id);

    if (myCrystal) {
      cameraXRef.current = Math.max(0, Math.min(myCrystal.x - viewW / 2, mapWidth - viewW));
    } else if (isReplay) {
      // Observer view: center on map, guarded against 0-width container at mount time
      const w = viewW > 0 ? viewW : 960;
      cameraXRef.current = Math.max(0, Math.min(mapWidth / 2 - w / 2, mapWidth - w));
    } else if (myIdx === 0) {
      cameraXRef.current = 0;
    } else {
      cameraXRef.current = Math.max(0, mapWidth - viewW);
    }
    // Vertically center the map in the viewport.
    // Allow negative cameraY — when viewport is taller than the map,
    // this pushes the map down, centering it visually with equal space above and below.
    cameraYRef.current = (mapHeight - viewH) / 2;

  }, [matchState, safePlayer.id]);

  // Resize handler with DPR support
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleResize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const parent = container;
      const cssW = parent.clientWidth;
      const cssH = parent.clientHeight;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
      }
    };

    handleResize();

    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Edge scrolling loop + window mouseup guard
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // Clear minimap drag on any window-level mouseup (catches releases outside canvas)
    const onWindowMouseUp = () => {
      minimapDraggingRef.current = false;
    };

    canvas.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
  }, []);

  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !matchState) return false;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      const minimapX = canvas.clientWidth - MINIMAP_WIDTH - 10;
      const minimapY = canvas.clientHeight - MINIMAP_HEIGHT - 10;

      if (
        screenX >= minimapX &&
        screenX <= minimapX + MINIMAP_WIDTH &&
        screenY >= minimapY &&
        screenY <= minimapY + MINIMAP_HEIGHT
      ) {
        const fraction = (screenX - minimapX) / MINIMAP_WIDTH;
        const mapWidth = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
        const viewW = canvas.clientWidth;
        cameraXRef.current = Math.max(0, Math.min(fraction * mapWidth - viewW / 2, mapWidth - viewW));
        minimapDraggingRef.current = true;
        return true;
      }
      return false;
    },
    [matchState]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Clear any stuck minimap drag state on any new mouse down
      minimapDraggingRef.current = false;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      if (handleMinimapClick(e)) return;

      const worldX = screenX + cameraXRef.current;
      const worldY = screenY + cameraYRef.current;

      // Left click: selection + build placement
      if (e.button === 0) {
        // Debug drag resource node mode: left-click to pick up a node
        if (debugDragMode) {
          for (const node of resourceNodes) {
            const dx = worldX - node.x;
            const dy = worldY - node.y;
            if (Math.sqrt(dx * dx + dy * dy) <= node.radius + 10) {
              setDebugDraggingNodeId(node.id);
              return;
            }
          }
          // Clicked empty space while in drag mode — cancel
          setDebugDraggingNodeId(null);
          return;
        }

        // Rally point placement mode
        if (rallyMode) {
          onGameCommand({
            type: "set_rally",
            entityId: rallyMode.buildingId,
            targetX: worldX,
            targetY: worldY,
          });
          setRallyMode(null);
          return;
        }

        // Debug spawn mode: spawn entity at clicked position
        if (debugSpawnMode) {
          const isBuilding = debugSpawnMode.startsWith("building:");
          const entityType = isBuilding ? "building" : debugSpawnMode;
          const buildingType = isBuilding ? debugSpawnMode.replace("building:", "") : undefined;
          onDebugSpawn(entityType, worldX, worldY, buildingType);
          setDebugSpawnMode(null);
          return;
        }

        // Start drag origin for box-select
        setIsDragging(true);
        setDragStart({ x: screenX, y: screenY });
        return;
      }

      // Middle click: pan camera (or cancel drag mode)
      if (e.button === 1) {
        e.preventDefault();
        if (debugDragMode) {
          setDebugDragMode(false);
          setDebugDraggingNodeId(null);
          return;
        }
        return;
      }

      // Right click: commands
      if (e.button === 2) {
        if (buildMode) {
          setBuildMode(false);
          setSelectedBuildingType(null);
        }
        const allSelectedIds = selectedEntityIds.size > 0 ? selectedEntityIds : (selectedEntityId ? new Set([selectedEntityId]) : new Set());
        if (allSelectedIds.size === 0) return;

        // Hit detection for target entity
        let clickedEntity: MatchEntity | undefined;
        for (const entity of matchState?.entities ?? []) {
          const dx = worldX - entity.x;
          const dy = worldY - entity.y;
          const hitRadius = entity.type === "building"
            ? (entity.buildingType && BUILDING_SIZES[entity.buildingType]
              ? Math.max(BUILDING_SIZES[entity.buildingType].w, BUILDING_SIZES[entity.buildingType].h) / 2
              : 22)
            : entity.type === "crystal" ? 22 : entity.radius;
          if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) {
            clickedEntity = entity;
            break;
          }
        }

        let clickedNode: ResourceNodeDisplay | null = null;
        for (const node of resourceNodes) {
          const dx = worldX - node.x;
          const dy = worldY - node.y;
          if (Math.sqrt(dx * dx + dy * dy) <= node.radius) {
            clickedNode = node;
            break;
          }
        }

        // Issue command to each selected unit
        for (const sid of allSelectedIds as Iterable<string>) {
          const selEntity = myEntities.find((ent) => ent.id === sid);
          if (!selEntity) continue;

          // Skip buildings/crystals - they can't move/attack
          if (selEntity.type === "crystal" || selEntity.type === "building") continue;

          // Attack enemy unit/building
          if (clickedEntity && clickedEntity.ownerId !== safePlayer.id) {
            onGameCommand({
              type: "attack",
              entityId: sid,
              targetEntityId: clickedEntity.id,
            });
            continue;
          }

          // Medic heal friendly unit
          if (selEntity.type === "medic" && clickedEntity && clickedEntity.ownerId === safePlayer.id &&
              clickedEntity.type !== "crystal" && clickedEntity.type !== "building") {
            onGameCommand({
              type: "heal",
              entityId: sid,
              targetEntityId: clickedEntity.id,
            });
            continue;
          }

          // Worker build friendly building under construction
          if (selEntity.type === "worker" && clickedEntity &&
              clickedEntity.type === "building" && clickedEntity.ownerId === safePlayer.id &&
              clickedEntity.constructionProgress !== undefined &&
              clickedEntity.constructionProgress < 100) {
            onGameCommand({
              type: "assign_build",
              entityId: sid,
              targetEntityId: clickedEntity.id,
            });
            continue;
          }

          // Worker repair friendly building
          if (selEntity.type === "worker" && clickedEntity &&
              clickedEntity.type === "building" && clickedEntity.ownerId === safePlayer.id &&
              clickedEntity.health < clickedEntity.maxHealth) {
            onGameCommand({
              type: "repair",
              entityId: sid,
              targetEntityId: clickedEntity.id,
            });
            continue;
          }

          // Worker gather from resource node
          if (selEntity.type === "worker" && clickedNode) {
            onGameCommand({
              type: "gather",
              entityId: sid,
              targetEntityId: clickedNode.id,
            });
            continue;
          }

          // Move to ground position
          onGameCommand({
            type: "move",
            entityId: sid,
            targetX: worldX,
            targetY: worldY,
          });
        }
      }
    },
    [myEntities, selectedEntityId, selectedEntityIds, resourceNodes, onGameCommand, buildMode, selectedBuildingType, myCrystal, matchState, handleMinimapClick, safePlayer.id, rallyMode, debugDragMode, debugDraggingNodeId, debugSpawnMode]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      mousePosRef.current = { x: screenX, y: screenY };

      const worldX = screenX + cameraXRef.current;
      const worldY = screenY + cameraYRef.current;
      setHoverPos({ x: worldX, y: worldY });

      // Debug drag resource node (throttled to ~10 cmds/sec)
      if (debugDraggingNodeId) {
        const now = performance.now();
        if (now - debugDragLastSendRef.current > 100) {
          debugDragLastSendRef.current = now;
          onGameCommand({
            type: "debug_move_node",
            targetEntityId: debugDraggingNodeId,
            targetX: worldX,
            targetY: worldY,
          });
        }
        return;
      }
    },
    [debugDraggingNodeId, onGameCommand]
  );

  const handleMouseLeave = useCallback(() => {
    mousePosRef.current = null;
  }, []);

   // Keyboard handler for Escape to cancel build mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && buildModeRef.current) {
        setBuildMode(false);
        setSelectedBuildingType(null);
        setShowUnitQueue(false);
      }
      if (e.key === "Escape" && debugSpawnModeRef.current) {
        setDebugSpawnMode(null);
      }
      if (e.key === "Escape" && rallyMode) {
        setRallyMode(null);
        return;
      }
      if (e.key === "Escape" && (debugDragMode || debugDraggingNodeId)) {
        setDebugDragMode(false);
        setDebugDraggingNodeId(null);
        return;
      }
      // Enter rally mode with 'F' when a building or crystal is selected
      if (e.key === "f" || e.key === "F") {
        // Find a production building or crystal from the current selection
        const selectedIds = Array.from(selectedEntityIds);
        const targetId = selectedEntityId ?? selectedIds[0] ?? null;
        if (targetId && matchState) {
          const entity = matchState.entities.find((ent) => ent.id === targetId);
          if (entity && (entity.type === "building" || entity.type === "crystal") && entity.ownerId === safePlayer.id) {
            setRallyMode({ buildingId: entity.id });
            return;
          }
        }
        // If in rally mode, cancel it
        if (rallyMode) {
          setRallyMode(null);
          return;
        }
      }

      // Hotkey handling - QWER/ASDF
      const key = e.key.toLowerCase();
      const hotkey = hotkeys.find((h: HotkeySlot) => h.key === key);
      if (hotkey && !e.ctrlKey && !e.metaKey && !e.altKey && hotkey.action !== "none") {
        // Flash the hotkey
        setHotkeyFlash(key);
        setTimeout(() => setHotkeyFlash(null), 200);

        const selectedIds = Array.from(selectedEntityIds);
        const entities = matchState?.entities ?? [];

        // Filter to only movable units (exclude buildings/crystals)
        const movableUnitIds = selectedIds.filter(
          (id) => {
            const ent = entities.find((e) => e.id === id);
            return ent && ent.type !== "building" && ent.type !== "crystal" && ent.ownerId === safePlayer.id;
          }
        );

        switch (hotkey.action) {
          case "train_worker": {
            // Train worker from selected crystal
            const crystal = selectedIds
              .map((id) => entities.find((ent) => ent.id === id))
              .filter((ent): ent is MatchEntity => ent != null && ent.type === "crystal" && ent.ownerId === safePlayer.id);
            if (crystal.length > 0) {
              onGameCommand({ type: "train_worker", entityId: crystal[0].id });
            }
            break;
          }
          case "train_skirmisher":
          case "train_gunner":
          case "train_bruiser":
          case "train_medic": {
            // Train unit from selected building
            const unitType = hotkey.action.replace("train_", "");
            let building: MatchEntity | undefined;
            if (unitType === "skirmisher" || unitType === "gunner") {
              building = selectedIds
                .map((id) => entities.find((ent) => ent.id === id))
                .find((ent): ent is MatchEntity => ent != null && ent.type === "building" && ent.buildingType === "barracks" && ent.ownerId === safePlayer.id);
            } else {
              building = selectedIds
                .map((id) => entities.find((ent) => ent.id === id))
                .find((ent): ent is MatchEntity => ent != null && ent.type === "building" && ent.buildingType === "foundry" && ent.ownerId === safePlayer.id);
            }
            if (building) {
              onGameCommand({
                type: "train_unit",
                buildingId: building.id,
                entityId: building.id,
                targetEntityId: unitType,
              });
            }
            break;
          }
          case "build_supply_depot":
          case "build_barracks":
          case "build_foundry":
          case "build_turret": {
            // Enter build mode — identical to bottom bar buttons
            const buildingType = hotkey.action.replace("build_", "") as BuildingType;
            handleBuildClick(buildingType);
            break;
          }
          case "toggle_auto_attack": {
            // Toggle auto-attack on compatible units (those with attack capability)
            if (movableUnitIds.length > 0) {
              onGameCommand({
                type: "toggle_auto_attack",
                entityIds: movableUnitIds,
              });
            }
            break;
          }
          case "unit_stop": {
            // Stop all selected movable units
            if (movableUnitIds.length > 0) {
              onGameCommand({
                type: "stop",
                entityIds: movableUnitIds,
              });
            }
            break;
          }
          case "retreat": {
            // Retreat all selected movable units to own crystal
            if (movableUnitIds.length > 0) {
              onGameCommand({
                type: "retreat",
                entityIds: movableUnitIds,
              });
            }
            break;
          }
          case "set_rally": {
            // Enter rally point placement mode for selected production building
            if (selectedEntityId) {
              const entity = entities.find((ent) => ent.id === selectedEntityId);
              if (entity && (entity.type === "building" || entity.type === "crystal") && entity.ownerId === safePlayer.id) {
                setRallyMode({ buildingId: entity.id });
              }
            }
            break;
          }
          case "fortify": {
            // Fortify: workers repair buildings, medics heal units, others do nothing
            if (movableUnitIds.length > 0) {
              const workers = movableUnitIds.filter(
                (id) => entities.find((ent) => ent.id === id)?.type === "worker"
              );
              const medics = movableUnitIds.filter(
                (id) => entities.find((ent) => ent.id === id)?.type === "medic"
              );

              // Workers repair nearest damaged friendly building
              for (const wid of workers) {
                const damagedBuildings = entities.filter(
                  (ent) => ent.type === "building" && ent.ownerId === safePlayer.id && ent.health < ent.maxHealth
                );
                if (damagedBuildings.length > 0) {
                  const worker = entities.find((ent) => ent.id === wid);
                  let nearest = damagedBuildings[0];
                  let nearestDist = Infinity;
                  for (const b of damagedBuildings) {
                    const d = Math.hypot((worker?.x ?? 0) - b.x, (worker?.y ?? 0) - b.y);
                    if (d < nearestDist) { nearestDist = d; nearest = b; }
                  }
                  onGameCommand({
                    type: "repair",
                    entityId: wid,
                    targetEntityId: nearest.id,
                  });
                }
              }

              // Medics heal nearest damaged friendly unit
              for (const mid of medics) {
                const damagedUnits = entities.filter(
                  (ent) => ent.type !== "building" && ent.type !== "crystal" && ent.ownerId === safePlayer.id && ent.health < ent.maxHealth
                );
                if (damagedUnits.length > 0) {
                  const medic = entities.find((ent) => ent.id === mid);
                  let nearest = damagedUnits[0];
                  let nearestDist = Infinity;
                  for (const u of damagedUnits) {
                    const d = Math.hypot((medic?.x ?? 0) - u.x, (medic?.y ?? 0) - u.y);
                    if (d < nearestDist) { nearestDist = d; nearest = u; }
                  }
                  onGameCommand({
                    type: "heal",
                    entityId: mid,
                    targetEntityId: nearest.id,
                  });
                }
              }
            }
            break;
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [rallyMode, selectedEntityId, selectedEntityIds, matchState, safePlayer.id, hotkeys]);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Drop debug-dragged resource node
      if (e.button === 0 && debugDraggingNodeId) {
        setDebugDraggingNodeId(null);
        return;
      }
      // Stop minimap drag
      if (e.button === 0 && minimapDraggingRef.current) {
        minimapDraggingRef.current = false;
        return;
      }
      if (e.button === 0 && isDragging && dragStart) {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        const dx = screenX - dragStart.x;
        const dy = screenY - dragStart.y;

        // Build placement takes priority over selection
        if (buildMode && selectedBuildingType && Math.abs(dx) <= 10 && Math.abs(dy) <= 10) {
          const worldX = screenX + cameraXRef.current;
          const worldY = screenY + cameraYRef.current;
          const workerIds = Array.from(selectedEntityIds).filter((id) =>
            myEntities.find((ent) => ent.id === id && ent.type === "worker")
          );
          if (workerIds.length > 0) {
            onGameCommand({
              type: "build",
              workerIds,
              buildingType: selectedBuildingType,
              targetX: worldX,
              targetY: worldY,
            });
          }
          setBuildMode(false);
          setSelectedBuildingType(null);
          setIsDragging(false);
          setDragStart(null);
          return;
        }

        // Box-select if dragged more than 10px
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          const x1 = Math.min(dragStart.x, screenX);
          const y1 = Math.min(dragStart.y, screenY);
          const x2 = Math.max(dragStart.x, screenX);
          const y2 = Math.max(dragStart.y, screenY);

          const worldX1 = x1 + cameraXRef.current;
          const worldY1 = y1 + cameraYRef.current;
          const worldX2 = x2 + cameraXRef.current;
          const worldY2 = y2 + cameraYRef.current;

          const boxSelected = new Set<string>();
          for (const entity of matchState?.entities ?? []) {
            if (entity.ownerId !== safePlayer.id) continue;
            if (entity.type === "crystal" || entity.type === "building") continue;
            if (entity.x >= worldX1 && entity.x <= worldX2 && entity.y >= worldY1 && entity.y <= worldY2) {
              boxSelected.add(entity.id);
            }
          }

          setSelectedEntityIds(boxSelected);
          setSelectedEntityId(null);
        }
        // Single-click: hit detection
        else {
          const worldX = screenX + cameraXRef.current;
          const worldY = screenY + cameraYRef.current;

          let clickedEntity: MatchEntity | undefined;
          for (const entity of matchState?.entities ?? []) {
            const entityDx = worldX - entity.x;
            const entityDy = worldY - entity.y;
            const hitRadius = entity.type === "building"
              ? (entity.buildingType && BUILDING_SIZES[entity.buildingType]
                ? Math.max(BUILDING_SIZES[entity.buildingType].w, BUILDING_SIZES[entity.buildingType].h) / 2
                : 22)
              : entity.type === "crystal" ? 22 : entity.radius;
            if (Math.sqrt(entityDx * entityDx + entityDy * entityDy) <= hitRadius) {
              clickedEntity = entity;
              break;
            }
          }

          if (clickedEntity) {
            setSelectedEntityId(clickedEntity.id);
            setSelectedEntityIds(new Set([clickedEntity.id]));
          } else {
            setSelectedEntityId(null);
            setSelectedEntityIds(new Set());
          }
        }
      }
      setIsDragging(false);
      setDragStart(null);
    },
    [isDragging, dragStart, matchState, safePlayer.id]
  );

  const handleTrainWorker = useCallback(() => {
    if (myCrystal) {
      onGameCommand({ type: "train_worker", entityId: myCrystal.id });
    }
  }, [myCrystal, onGameCommand]);

  const handleBuildClick = useCallback(
    (type: BuildingType) => {
      setSelectedBuildingType(type);
      setBuildMode(true);
    },
    []
  );

  const handleCancelBuild = useCallback(() => {
    setBuildMode(false);
    setSelectedBuildingType(null);
    setShowUnitQueue(false);
  }, []);

  // 60fps render loop with interpolation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let running = true;

    const render = () => {
      if (!running) return;

      const ms = matchStateRef.current;
      if (!ms) {
        animId = requestAnimationFrame(render);
        return;
      }

      const now = Date.now();

      // Edge scrolling + minimap drag
      const edgeCanvas = canvasRef.current;
      if (edgeCanvas) {
        const pos = mousePosRef.current;
        if (pos) {
          const viewW = edgeCanvas.clientWidth;

          // Minimap drag: update camera while dragging on minimap (X-axis only)
          if (minimapDraggingRef.current) {
            const mmX = viewW - MINIMAP_WIDTH - 10;
            const xFraction = Math.max(0, Math.min(1, (pos.x - mmX) / MINIMAP_WIDTH));
            const mapWidth = ms.mapWidth ?? 6000;
            cameraXRef.current = Math.max(0, Math.min(xFraction * mapWidth - viewW / 2, mapWidth - viewW));
          }

          // Edge scrolling — X-axis only (Y is locked, game is side-scrolling)
          if (!minimapDraggingRef.current) {
            let dx = 0;
            if (pos.x < EDGE_SCROLL_THRESHOLD) dx = -EDGE_SCROLL_SPEED;
            else if (pos.x > viewW - EDGE_SCROLL_THRESHOLD) dx = EDGE_SCROLL_SPEED;
            if (dx !== 0) {
              const mapWidth = ms.mapWidth ?? 6000;
              cameraXRef.current = Math.max(0, Math.min(mapWidth - viewW, cameraXRef.current + dx));
            }
          }
        }
      }

      const entities = ms.entities;

      // Detect dead entities and spawn particles
      const currentIds = new Set(entities.map((e: MatchEntity) => e.id));
      const prevIds = prevEntityIdsRef.current;
      for (const prevId of prevIds) {
        if (!currentIds.has(prevId)) {
          const prevHealth = prevEntityHealthRef.current.get(prevId);
          if (prevHealth === undefined || prevHealth > 0) continue; // left vision, not dead
          const prevPos = prevEntitiesRef.current.get(prevId);
          const deadEntity = ms.entities.find((e: MatchEntity) => e.id === prevId);
          const isCrystal = deadEntity?.type === "crystal";
          const px = prevPos?.x ?? (deadEntity?.x ?? 0);
          const py = prevPos?.y ?? (deadEntity?.y ?? 0);
          const color = isCrystal ? "#7ce8ff" : "#ff5cf3";
          for (let i = 0; i < 10; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 2;
            particlesRef.current.push({
              x: px, y: py,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 30, maxLife: 30,
              color, size: 2 + Math.random()
            });
          }
        }
      }
      prevEntityIdsRef.current = currentIds;

      // --- Client-side interpolation ---
      //
      // Architecture:
      // - oldPositionsRef: positions from the PREVIOUS server state (source of lerp)
      // - prevEntitiesRef: positions from the CURRENT server state (target of lerp)
      // - prevTimestampRef: client receive time of the current state
      // - lastTickRef: tick number of the last-processed state
      //
      // When new state arrives (tick changes):
      //   1. Shift current positions → old positions
      //   2. Store new positions as current
      //   3. Record receive time
      //
      // Each frame: lerp from old → current based on elapsed time since receive.
      // Once alpha >= 1, snap to current and clear old (stop interpolating).
      // This gives smooth movement with no backward jumps.

      const tickMs = ms.tickIntervalMs ?? 100;

      // Detect new state arrival via tick number
      const isNewState = (lastTickRef.current !== ms.tick);

      if (isNewState) {
        // Shift: current → old, new → current
        // Only keep entries for entities that still exist
        const entityIds = new Set(entities.map((e: MatchEntity) => e.id));
        const oldMap = new Map<string, { x: number; y: number }>();
        for (const [id, pos] of prevEntitiesRef.current) {
          if (entityIds.has(id)) {
            oldMap.set(id, pos);
          }
        }
        oldPositionsRef.current = oldMap;

        entities.forEach((e: MatchEntity) => {
          prevEntitiesRef.current.set(e.id, { x: e.x, y: e.y });
          prevEntityHealthRef.current.set(e.id, e.health);
        });

        prevTimestampRef.current = Date.now();
        lastTickRef.current = ms.tick;
      }

      // Skip interpolation if we don't have both old and current
      const hasOld = oldPositionsRef.current.size > 0;

      let interpolatedEntities: MatchEntity[];

      if (!hasOld || !prevTimestampRef.current) {
        // First frame or no previous state — just use current positions
        entities.forEach((e: MatchEntity) => {
          prevEntitiesRef.current.set(e.id, { x: e.x, y: e.y });
          prevEntityHealthRef.current.set(e.id, e.health);
        });
        oldPositionsRef.current = new Map(prevEntitiesRef.current);
        prevTimestampRef.current = Date.now();
        lastTickRef.current = ms.tick;
        interpolatedEntities = entities;
      } else {
        // Compute interpolation progress
        const elapsed = now - prevTimestampRef.current;
        const alpha = Math.max(0, Math.min(1, elapsed / tickMs));

        interpolatedEntities = entities.map((e: MatchEntity) => {
          const old = oldPositionsRef.current.get(e.id);
          const curr = prevEntitiesRef.current.get(e.id);
          if (!old || !curr) return e;

          const dx = curr.x - old.x;
          const dy = curr.y - old.y;

          return {
            ...e,
            x: old.x + dx * alpha,
            y: old.y + dy * alpha,
          } as MatchEntity;
        });

        // Once interpolation is complete, clear old buffer
        // so we stop lerping and just render current positions
        if (alpha >= 1) {
          oldPositionsRef.current.clear();
        }
      }

      drawGameScene(
        canvas, ctx, interpolatedEntities, resourceNodesRef.current,
        selectedEntityIdRef.current, hoverPosRef.current, buildModeRef.current,
        selectedBuildingTypeRef.current, ms, playerRef.current
      );

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => {
      running = false;
      cancelAnimationFrame(animId);
    };
  }, []);

  // Draw function
  function drawGameScene(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    entities: MatchEntity[],
    resourceNodes: ResourceNodeDisplay[],
    selectedEntityId: string | null,
    hoverPos: { x: number; y: number } | null,
    buildMode: boolean,
    selectedBuildingType: BuildingType | null,
    matchState: MatchState,
    player: Player,
 
  ) {
    const dpr = dprRef.current;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const myCrystal = entities.find((e) => e.type === "crystal" && e.ownerId === safePlayer.id);

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, cssW, cssH);

    const cameraX = cameraXRef.current;
    const cameraY = cameraYRef.current;
    const mapWidth = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
    const mapHeight = matchState.mapHeight ?? matchState.config?.mapHeight ?? 600;

    const getTeamColor = (ownerId: string) => {
      const pIdx = matchState.players.findIndex((p) => p?.playerId === ownerId);
      return pIdx === 0 ? "#7ce8ff" : "#ff5cf3";
    };

    const laneTop = mapHeight * 0.2;
    const laneBottom = mapHeight * 0.8;
    const combatZoneTop = mapHeight * 0.3;
    const combatZoneBottom = mapHeight * 0.7;

    ctx.save();
    ctx.translate(-cameraX, -cameraY);

    // Lane background
    ctx.fillStyle = "#0a0c14";
    ctx.fillRect(0, laneTop, mapWidth, laneBottom - laneTop);

    // Combat zone
    const combatLeft = mapWidth * 0.25;
    const combatRight = mapWidth * 0.75;
    ctx.fillStyle = "#0d1020";
    ctx.fillRect(combatLeft, combatZoneTop, combatRight - combatLeft, combatZoneBottom - combatZoneTop);

    // Build zones
    ctx.fillStyle = "rgba(124, 232, 255, 0.05)";
    ctx.fillRect(0, 0, mapWidth * 0.2, mapHeight);
    ctx.fillStyle = "rgba(255, 92, 243, 0.05)";
    ctx.fillRect(mapWidth * 0.8, 0, mapWidth * 0.2, mapHeight);

    // ─── Vision fog overlay (tile-based, drawn BEFORE entities) ─
    // Tiles outside all vision sources are darkened. Drawn before
    // entities so player units always render clearly on top.
    {
      const myVisionSources = entities.filter(
        (e) => e.ownerId === safePlayer.id && e.health > 0
      );

      if (myVisionSources.length > 0) {
        const visionData: { x: number; y: number; rngSq: number }[] = [];
        for (const src of myVisionSources) {
          let rng = 100;
          if (src.type === "crystal") rng = 225;
          else {
            const def = UNIT_DEFS[src.type] ?? BUILDING_DEFS[src.buildingType ?? ""] ?? {};
            rng = (def.visionRange as number) ?? 100;
          }
          visionData.push({ x: src.x, y: src.y, rngSq: rng * rng });
        }

        const TILE = 14;
        const tSX = Math.floor(cameraX / TILE) * TILE;
        const tSY = Math.floor(cameraY / TILE) * TILE;
        const tEX = cameraX + cssW + TILE;
        const tEY = cameraY + cssH + TILE;

        ctx.globalAlpha = 0.48;
        ctx.fillStyle = "#050816";

        for (let tx = tSX; tx < tEX; tx += TILE) {
          for (let ty = tSY; ty < tEY; ty += TILE) {
            const cx = tx + TILE / 2;
            const cy = ty + TILE / 2;
            let visible = false;
            for (const v of visionData) {
              const dx = cx - v.x;
              const dy = cy - v.y;
              if (dx * dx + dy * dy <= v.rngSq) { visible = true; break; }
            }
            if (!visible) ctx.fillRect(tx, ty, TILE, TILE);
          }
        }
        ctx.globalAlpha = 1.0;
      }
    }

    // Lane lines
    ctx.strokeStyle = "#0f1320";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, laneTop);
    ctx.lineTo(mapWidth, laneTop);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, laneBottom);
    ctx.lineTo(mapWidth, laneBottom);
    ctx.stroke();

    // Center dashed line
    const midX = mapWidth / 2;
    ctx.strokeStyle = "#1a1f3a";
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(midX, laneTop);
    ctx.lineTo(midX, laneBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Resource nodes
    for (const node of resourceNodes) {
      if (node.x < cameraX - node.radius * 2 || node.x > cameraX + cssW + node.radius * 2) continue;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
      const nodePulseA = 0.08 + 0.07 * Math.sin(Date.now() / 2000);
      ctx.fillStyle = `rgba(204, 170, 68, ${nodePulseA.toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      const depletion = node.remaining / node.capacity;
      ctx.fillStyle = `rgba(204, 170, 68, ${0.3 + depletion * 0.7})`;
      ctx.fill();
      ctx.strokeStyle = debugDraggingNodeId === node.id ? "#ff4444" : debugDragMode ? "#ffaa44" : "#ccaa44";
      ctx.lineWidth = debugDraggingNodeId === node.id ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${Math.floor(node.remaining)}`, node.x, node.y);
    }

    // Debug drag node indicator
    if (debugDraggingNodeId && hoverPos) {
      ctx.beginPath();
      ctx.arc(hoverPos.x, hoverPos.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 68, 68, 0.6)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 100, 100, 0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Entities
    for (const entity of entities) {
      const hitRadius = entity.type === "building" || entity.type === "crystal" ? 22 : entity.radius;
      if (entity.x < cameraX - hitRadius * 2 || entity.x > cameraX + cssW + hitRadius * 2) continue;
      const localIsMyTeam = entity.ownerId === safePlayer.id;
      const localIsSelected = entity.id === selectedEntityId;
      const localIsBuilding = entity.type === "building" || entity.type === "crystal";

      if (localIsBuilding) {
        const bHealthPct = entity.health / entity.maxHealth;
        const bFillColor = getTeamColor(entity.ownerId);
        const bW = entity.radius * 2;
        const bH = entity.radius * 2;
        const bBX = entity.x - bW / 2;
        const bBY = entity.y - bH / 2;

        // Draw FACET silhouette based on building type
        if (entity.type === "crystal") {
          const pulseA = 0.08 + 0.07 * Math.sin(Date.now() / 2000);
          drawCrystal(ctx, entity.x, entity.y, localIsMyTeam, pulseA);
        } else if (entity.buildingType === "barracks") {
          drawBarracks(ctx, entity.x, entity.y, localIsMyTeam);
        } else if (entity.buildingType === "foundry") {
          const furnaceAlpha = Math.sin(Date.now() / 900);
          drawFoundry(ctx, entity.x, entity.y, localIsMyTeam, furnaceAlpha);
        } else if (entity.buildingType === "supply_depot") {
          drawDepot(ctx, entity.x, entity.y, localIsMyTeam);
        } else if (entity.buildingType === "turret") {
          drawTurret(ctx, entity.x, entity.y, localIsMyTeam, localIsMyTeam ? 90 : 270);
        }

        // Selected glow — slow breathing pulse
        if (localIsSelected) {
          const glowAlpha = 0.35 + 0.5 * Math.sin(Date.now() / 1500);
          ctx.strokeStyle = `rgba(255,255,68,${glowAlpha.toFixed(2)})`;
          ctx.lineWidth = 2.5;
          ctx.strokeRect(bBX - 4, bBY - 4, bW + 8, bH + 8);
        }

        // Construction progress dark overlay
        if (entity.constructionProgress < 100) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(bBX, bBY, bW, bH);
          const progW = bW * (entity.constructionProgress / 100);
          ctx.fillStyle = bFillColor;
          ctx.fillRect(bBX, bBY, progW, bH);
        }

        // Repair overlay
        if (entity.repairTargetId && entity.health < entity.maxHealth) {
          const repairPct = (entity.repairProgress ?? 0) / Math.max(1, entity.maxHealth - entity.health);
          ctx.fillStyle = "rgba(68, 204, 68, 0.4)";
          ctx.fillRect(bBX, bBY, bW * repairPct, bH);
        }

        // Auto-attack dash border
        if (entity.autoAttackEnabled && !localIsSelected) {
          ctx.strokeStyle = "rgba(255,100,100,0.5)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(bBX - 3, bBY - 3, bW + 6, bH + 6);
          ctx.setLineDash([]);
        }

        // Construction progress bar
        if (entity.constructionProgress < 100) {
          const barWidth = bW;
          const barHeight = 4;
          const barY = bBY - 8;
          ctx.fillStyle = "#333";
          ctx.fillRect(bBX, barY, barWidth, barHeight);
          ctx.fillStyle = "#44cc44";
          ctx.fillRect(bBX, barY, barWidth * (entity.constructionProgress / 100), barHeight);
          const workerCount = entity.buildWorkerIds?.length ?? 0;
          if (workerCount > 0) {
            ctx.fillStyle = "#aaa";
            ctx.font = "8px monospace";
            ctx.textAlign = "center";
            ctx.fillText(`${workerCount}W`, entity.x, barY - 3);
          }
        }

        // Health bar below building
        if (entity.health < entity.maxHealth) {
          ctx.fillStyle = "#333";
          ctx.fillRect(bBX, bBY + bH + 4, bW, 4);
          ctx.fillStyle = bFillColor;
          ctx.fillRect(bBX, bBY + bH + 4, bW * bHealthPct, 4);
        }

        // Production queue bar
        if (entity.productionQueue.length > 0) {
          const firstItem = entity.productionQueue[0];
          const queueBarY = bBY + bH + 10;
          ctx.fillStyle = "#333";
          ctx.fillRect(bBX, queueBarY, bW, 4);
          const prodPct = 1 - firstItem.remainingTicks / firstItem.buildTime;
          ctx.fillStyle = "#7ce8ff";
          ctx.fillRect(bBX, queueBarY, bW * prodPct, 4);
          ctx.fillStyle = "#aaa";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.fillText(`${firstItem.unitType}: ${Math.ceil(firstItem.remainingTicks / 10)}s`, entity.x, queueBarY + 12);
        }
      } else {
        // Determine facing (skirmisher/gunner)
        let facing = "r";
        if (entity.attackTargetId && entities) {
          const target = entities.find((e) => e.id === entity.attackTargetId);
          if (target && target.x < entity.x) facing = "l";
        } else if (entity.moveTarget !== undefined && entity.moveTarget.x < entity.x) {
          facing = "l";
        }

        const isUnitSelected = localIsSelected || selectedEntityIdsRef.current.has(entity.id);

        // Draw FACET silhouette based on unit type
        if (entity.type === "worker") {
          drawWorker(ctx, entity.x, entity.y, localIsMyTeam, isUnitSelected);
        } else if (entity.type === "skirmisher") {
          drawSkirmisher(ctx, entity.x, entity.y, localIsMyTeam, isUnitSelected, facing);
        } else if (entity.type === "gunner") {
          drawGunner(ctx, entity.x, entity.y, localIsMyTeam, isUnitSelected, facing);
        } else if (entity.type === "bruiser") {
          drawBruiser(ctx, entity.x, entity.y, localIsMyTeam, isUnitSelected);
        } else if (entity.type === "medic") {
          drawMedic(ctx, entity.x, entity.y, localIsMyTeam, isUnitSelected);
        }

        // Auto-attack enabled dash border
        if (entity.autoAttackEnabled && !isUnitSelected) {
          ctx.beginPath();
          ctx.arc(entity.x, entity.y, entity.radius + 3, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,100,100,0.5)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Health bar above unit
        if (entity.health < entity.maxHealth) {
          const barWidth = entity.radius * 2;
          const barX = entity.x - entity.radius;
          const barY = entity.y - entity.radius - 8;
          const healthPct = entity.health / entity.maxHealth;
          ctx.fillStyle = "#333";
          ctx.fillRect(barX, barY, barWidth, 4);
          ctx.fillStyle = getTeamColor(entity.ownerId);
          ctx.fillRect(barX, barY, barWidth * healthPct, 4);
        }
      }
    }

    // Rally point markers — always visible for own buildings
    for (const entity of entities) {
      if (entity.rallyPoint && entity.ownerId === safePlayer.id) {
        const rx = entity.rallyPoint.x;
        const ry = entity.rallyPoint.y;
        const isSelected = selectedEntityIds.has(entity.id);

        // Dotted line from building to rally point — only when selected
        if (isSelected) {
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([6, 4]);
          ctx.moveTo(entity.x, entity.y);
          ctx.lineTo(rx, ry);
          ctx.strokeStyle = "rgba(255, 180, 50, 0.5)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }

        // Rally point marker - orange diamond (always visible)
        ctx.save();
        ctx.translate(rx, ry);
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.rect(-5, -5, 10, 10);
        ctx.fillStyle = isSelected ? "rgba(255, 180, 50, 0.8)" : "rgba(255, 180, 50, 0.4)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 220, 100, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Rally point placement indicator
    if (rallyMode && hoverPos) {
      ctx.beginPath();
      ctx.arc(hoverPos.x, hoverPos.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 180, 50, 0.6)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 220, 100, 0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Crosshair
      ctx.beginPath();
      ctx.moveTo(hoverPos.x - 10, hoverPos.y);
      ctx.lineTo(hoverPos.x + 10, hoverPos.y);
      ctx.moveTo(hoverPos.x, hoverPos.y - 10);
      ctx.lineTo(hoverPos.x, hoverPos.y + 10);
      ctx.strokeStyle = "rgba(255, 220, 100, 0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Attack visualization lines
    drawAttackLines(ctx, entities, matchState);

    // Medic attachment lines (dotted line even when not actively healing)
    for (const entity of entities) {
      if (entity.type === "medic" && entity.healTargetId) {
        const target = entities.find((e) => e.id === entity.healTargetId);
        if (target) {
          ctx.beginPath();
          ctx.moveTo(entity.x, entity.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = "rgba(80,255,80,0.25)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
          if (!entity.attackTargetId) {
            ctx.beginPath();
            ctx.arc(entity.x, entity.y, entity.radius + 3, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(80,255,80,0.35)";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }

    // Gather lines (yellow)
    drawGatherLines(ctx, entities, resourceNodes);

    // Construction lines (green)
    drawConstructionLines(ctx, entities);

    // Death particles
    const particles = particlesRef.current;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life--;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      const alpha = p.life / p.maxLife;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color + Math.round(alpha * 255).toString(16).padStart(2, "0");
      ctx.fill();
    }

    // Hover line (only for movable units)
    if (hoverPos && selectedEntityId) {
      const entity = entities.find((e) => e.id === selectedEntityId);
      if (entity && entity.type !== "crystal" && entity.type !== "building") {
        ctx.beginPath();
        ctx.moveTo(entity.x, entity.y);
        ctx.lineTo(hoverPos.x, hoverPos.y);
        ctx.strokeStyle = "rgba(255,255,100,0.3)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(hoverPos.x, hoverPos.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,100,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Box-select rectangle (convert screen coords to world coords)
    if (isDraggingRef.current && dragStartRef.current) {
      const pos = mousePosRef.current;
      if (pos) {
        const sx1 = Math.min(dragStartRef.current.x, pos.x);
        const sy1 = Math.min(dragStartRef.current.y, pos.y);
        const sx2 = Math.max(dragStartRef.current.x, pos.x);
        const sy2 = Math.max(dragStartRef.current.y, pos.y);
        const w = sx2 - sx1;
        const h = sy2 - sy1;
        if (w > 10 || h > 10) {
          const wx1 = sx1 + cameraX;
          const wy1 = sy1 + cameraY;
          ctx.strokeStyle = "rgba(100,150,255,0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(wx1, wy1, w, h);
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(100,150,255,0.1)";
          ctx.fillRect(wx1, wy1, w, h);
        }
      }
    }

    // Build mode preview with validity indicator
    if (buildMode && selectedBuildingType && hoverPos) {
      const size = BUILDING_SIZES[selectedBuildingType];
      const halfW = size.w / 2;
      const halfH = size.h / 2;
      const midX = mapWidth / 2;
      const centerExclusion = 200;
      const isBlue = safePlayer.color === "blue";
      const inPlayerHalf = isBlue ? hoverPos.x < midX : hoverPos.x > midX;
      const notInCenter = isBlue ? hoverPos.x <= midX - centerExclusion : hoverPos.x >= midX + centerExclusion;
      const valid = inPlayerHalf && notInCenter;
      const previewColor = valid ? "rgba(68,204,68,0.5)" : "rgba(204,68,68,0.5)";
      const borderColor = valid ? "rgba(68,204,68,0.8)" : "rgba(204,68,68,0.8)";

      ctx.beginPath();
      ctx.arc(hoverPos.x, hoverPos.y, halfW + 2, 0, Math.PI * 2);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const color = BUILDING_COLORS[selectedBuildingType];
      ctx.fillStyle = valid ? `${color}66` : "rgba(204,68,68,0.3)";
      ctx.fillRect(hoverPos.x - halfW, hoverPos.y - halfH, halfW * 2, halfH * 2);
    }

    ctx.restore();

    // Minimap
    if (matchState) {
      const minimapX = cssW - MINIMAP_WIDTH - 10;
      const minimapY = cssH - MINIMAP_HEIGHT - 10;
      drawMinimap(
        ctx,
        matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000,
        matchState.mapHeight ?? matchState.config?.mapHeight ?? 600,
        cameraXRef.current,
        cssW,
        resourceNodes,
        entities,
        safePlayer.color,
        minimapX,
        minimapY
      );

      // Minimap fog overlay (tile-based, screen space)
      {
        const mmSources = entities.filter(e => e.ownerId === safePlayer.id && e.health > 0);
        if (mmSources.length > 0) {
          const mapW = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
          const xScale = MINIMAP_WIDTH / mapW;
          const yScale = MINIMAP_HEIGHT / (matchState.mapHeight ?? matchState.config?.mapHeight ?? 600);

          const mmData: { sx: number; sy: number; rngSq: number }[] = [];
          for (const src of mmSources) {
            let rng = 100;
            if (src.type === "crystal") rng = 225;
            else {
              const def = UNIT_DEFS[src.type] ?? BUILDING_DEFS[src.buildingType ?? ""] ?? {};
              rng = (def.visionRange as number) ?? 100;
            }
            const rr = rng * xScale;
            mmData.push({ sx: minimapX + src.x * xScale, sy: minimapY + src.y * yScale, rngSq: rr * rr });
          }

          const MMR = 4;
          const msx = Math.floor(minimapX / MMR) * MMR;
          const msy = Math.floor(minimapY / MMR) * MMR;
          const mex = minimapX + MINIMAP_WIDTH + MMR;
          const mey = minimapY + MINIMAP_HEIGHT + MMR;

          ctx.globalAlpha = 0.55;
          ctx.fillStyle = "#050816";

          for (let tx = msx; tx < mex; tx += MMR) {
            for (let ty = msy; ty < mey; ty += MMR) {
              const cx = tx + MMR/2;
              const cy = ty + MMR/2;
              let visible = false;
              for (const v of mmData) {
                const dx = cx - v.sx;
                const dy = cy - v.sy;
                if (dx*dx + dy*dy <= v.rngSq) { visible = true; break; }
              }
              if (!visible) ctx.fillRect(tx, ty, MMR, MMR);
            }
          }
          ctx.globalAlpha = 1.0;
        }
      }
    }

    ctx.restore();
  }



  const safeLobby = lobby ?? { code: "REPLAY", players: [null, null] as [null, null], status: "match" as const, hostId: "" };
  const opponent = safeLobby.players.find((p) => p?.id !== safePlayer.id);
  const opponentColor = opponent?.color === "blue" ? "#4488ff" : "#ff4444";
  const myColor = safePlayer.color === "blue" ? "#4488ff" : "#ff4444";

  const myEconomy = (() => {
    if (!matchState) return null;
    const myIdx = matchState.players.findIndex((p) => p?.playerId === safePlayer.id);
    if (myIdx < 0) return null;
    return matchState.economy[myIdx] ?? null;
  })();

  const opponentEconomy = (() => {
    if (!matchState) return null;
    const myIdx = matchState.players.findIndex((p) => p?.playerId === safePlayer.id);
    if (myIdx < 0) return null;
    const oppIdx = myIdx === 0 ? 1 : 0;
    return matchState.economy[oppIdx] ?? null;
  })();

  const canTrain = myCrystal && myEconomy && myEconomy.resources >= 25 && myEconomy.supply < myEconomy.maxSupply;
  const isCrystalSelected = selectedEntityId !== null && myCrystal?.id === selectedEntityId;
  const selectedEntity = selectedEntityId ? (matchState?.entities.find((e) => e.id === selectedEntityId) ?? myEntities.find((e) => e.id === selectedEntityId)) : undefined;
  const isBuildingSelected = selectedEntity?.type === "building";
  const isMultiSelect = selectedEntityIds.size > 0;

  const selectedWorkers = Array.from(selectedEntityIds).filter(
    (id) => myEntities.find((e) => e.id === id && e.type === "worker")
  );
  const hasSelectedWorkers = selectedWorkers.length > 0;

  const canBuildSupplyDepot = myEconomy && myEconomy.resources >= 50;
  const canBuildBarracks = myEconomy && myEconomy.resources >= 75;
  const canBuildFoundry = myEconomy && myEconomy.resources >= 100;
  const canBuildTurret = myEconomy && myEconomy.resources >= 60;

  return (
    <div style={styles.container}>
      <FctStyles />
      <div ref={containerRef} style={styles.gameContainer}>
        <canvas
          ref={canvasRef}
          onMouseDown={isReplay ? (e) => handleMinimapClick(e) : handleMouseDown}
          onMouseUp={isReplay ? undefined : handleMouseUp}
          onContextMenu={isReplay ? undefined : handleContextMenu}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={styles.canvas}
        />
        {error && (
          <div style={styles.errorBanner}>
            <span style={styles.errorText}>{error}</span>
            <button
              style={styles.errorCloseButton}
              onClick={() => {
                onClearError();
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div style={styles.overlay}>
          {/* Phase overlay band */}
          <div style={styles.phaseOverlay}>
            <span style={{ flex: 1 }} />
            <span>[{matchState?.phase === "playing" ? "IN GAME" : matchState?.phase?.toUpperCase() ?? "WAITING"}] · Tick: {matchState?.tick ?? 0}</span>
            <span style={{ flex: 1, textAlign: "right", color: FCT.inkFaint, fontWeight: 400 }}>
              Match: {(matchState?.id ?? "").slice(0, 8)}
            </span>
          </div>

          {/* Scoreboard with economy stats */}
          <div style={styles.scoreboard}>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <FctMark size={28} />
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: FCT.display, fontSize: 18, color: myColor === "#4488ff" ? FCT.ice : FCT.red, letterSpacing: "0.04em", fontWeight: 700 }}>
                  {safePlayer.username}
                </span>
                <span style={{ fontFamily: FCT.display, fontSize: 22, color: myColor === "#4488ff" ? FCT.ice : FCT.red, fontWeight: 700 }}>
                  {safePlayer.score}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <FctStat icon="⛏" label="RESOURCES" value={myEconomy?.resources ?? 0} tint={FCT.amber} />
              <FctStat icon="📦" label="SUPPLY" value={`${myEconomy?.supply ?? 0} / ${myEconomy?.maxSupply ?? 0}`} tint={FCT.green} />
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontFamily: FCT.display, fontSize: 22, color: opponentColor === "#ff4444" ? FCT.red : FCT.ice, fontWeight: 700 }}>
                {opponent?.score ?? 0}
              </span>
              <span style={{ fontFamily: FCT.display, fontSize: 18, color: opponentColor === "#ff4444" ? FCT.red : FCT.ice, letterSpacing: "0.04em", fontWeight: 700 }}>
                {opponent?.username ?? "..."}
              </span>
              <span style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkFaint, letterSpacing: "0.22em", marginLeft: 6 }}>
                VS
              </span>
            </div>
          </div>

          {/* Info bar — selection / status text only (tick lives in phase overlay) */}
          <div style={styles.infoBar}>
            <span style={{ color: FCT.ice }}>
              {buildMode && selectedBuildingType
                ? `Placing ${BUILDING_LABELS[selectedBuildingType]}`
                : isMultiSelect
                  ? `Selected ${selectedEntityIds.size} units`
                  : selectedEntityId
                    ? selectedEntity?.type === "crystal"
                      ? selectedEntity?.ownerId === safePlayer.id
                        ? `HQ · HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth} · Q: Worker`
                        : "Enemy HQ"
                      : selectedEntity?.type === "building"
                        ? `${selectedEntity.buildingType || "Building"} · HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth}${selectedEntity?.constructionProgress !== undefined && selectedEntity.constructionProgress < 100
                          ? ` · Building: ${Math.floor(selectedEntity.constructionProgress)}%`
                          : selectedEntity?.productionQueue.length > 0
                            ? ` · ${selectedEntity.productionQueue[0]?.unitType}: ${Math.ceil((selectedEntity.productionQueue[0]?.remainingTicks ?? 0) / 10)}s`
                            : ""}`
                        : selectedEntity?.ownerId === safePlayer.id
                          ? `${selectedEntity.type} · HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth}${selectedEntity.autoAttackEnabled ? " · AA:ON" : ""}`
                          : `Enemy ${selectedEntity?.type}`
                    : "Click ground to move · click node to gather · click enemy to attack"}
            </span>
          </div>

          {/* Hotkey Menu - QWER/ASDF Grid */}
          {showHotkeyMenu && (
            <div style={styles.hotkeyMenu}>
              {/* Selection info strip */}
              {selectedEntityId && selectedEntity && selectedEntity.ownerId === safePlayer.id && (
                <div style={styles.selectionInfo}>
                  <span style={styles.selectionInfoName}>
                    {selectedEntity.type === "crystal" ? "HQ" : selectedEntity.type === "building" ? (selectedEntity.buildingType ?? "Building") : selectedEntity.type}
                  </span>
                  <span style={styles.selectionInfoHp}>
                    HP: {Math.floor(selectedEntity.health)}/{selectedEntity.maxHealth}
                  </span>
                  {selectedEntity?.type === "building" && selectedEntity?.constructionProgress !== undefined && selectedEntity.constructionProgress < 100 && (
                    <span style={{ ...styles.selectionInfoHp, color: "#44cc44" }}>
                      Build: {Math.floor(selectedEntity.constructionProgress)}%
                    </span>
                  )}
                  {selectedEntity?.type === "building" && selectedEntity?.productionQueue.length > 0 && (
                    <span style={{ ...styles.selectionInfoHp, color: "#88aaff" }}>
                      {selectedEntity.productionQueue[0]?.unitType}: {Math.ceil((selectedEntity.productionQueue[0]?.remainingTicks ?? 0) / 10)}s
                      {selectedEntity.productionQueue.length > 1 ? ` (+${selectedEntity.productionQueue.length - 1})` : ""}
                    </span>
                  )}
                  {selectedEntity.autoAttackEnabled && (
                    <span style={{ ...styles.selectionInfoHp, color: "#88aaff" }}>AA:ON</span>
                  )}
                </div>
              )}
              <div style={styles.hotkeyRow}>
                {hotkeys.filter((h: HotkeySlot) => "qwer".includes(h.key)).map((hk: HotkeySlot) => (
                  <div
                    key={hk.key}
                    style={{
                      ...styles.hotkeySlot,
                      ...(hotkeyFlash === hk.key ? styles.hotkeyFlash : {}),
                    }}
                  >
                    <span style={styles.hotkeyLabel}>{hk.key.toUpperCase()}</span>
                    <span style={styles.hotkeyIcon}>{hk.icon}</span>
                    <span style={styles.hotkeyName}>{hk.label}</span>
                  </div>
                ))}
              </div>
              <div style={styles.hotkeyRow}>
                {hotkeys.filter((h: HotkeySlot) => "asdf".includes(h.key)).map((hk: HotkeySlot) => (
                  <div
                    key={hk.key}
                    style={{
                      ...styles.hotkeySlot,
                      ...(hotkeyFlash === hk.key ? styles.hotkeyFlash : {}),
                    }}
                  >
                    <span style={styles.hotkeyLabel}>{hk.key.toUpperCase()}</span>
                    <span style={styles.hotkeyIcon}>{hk.icon}</span>
                    <span style={styles.hotkeyName}>{hk.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Debug Panel - collapsible, default hidden */}
          <div style={styles.debugPanel}>
            <div
              style={styles.debugToggleBar}
              onClick={() => setDebugCollapsed(!debugCollapsed)}
            >
              <span style={styles.debugToggleArrow}>{debugCollapsed ? "▶" : "▼"}</span>
              <span style={styles.debugPanelHeader}>Debug Controls</span>
            </div>
            {!debugCollapsed && (
            <div style={styles.debugPanelBody}>
              <div style={styles.debugPanelRow}>
                <button
                  style={styles.debugButton}
                  onClick={() =>
                    onDebugWin(
                      safePlayer.id === safeLobby.players[0]?.id ? "player1" : "player2"
                    )
                  }
                >
                  Simulate My Win
                </button>
                <button
                  style={styles.debugButton}
                  onClick={() =>
                    onDebugWin(
                      safePlayer.id === safeLobby.players[0]?.id ? "player2" : "player1"
                    )
                  }
                >
                  Simulate Opponent Win
                </button>
              </div>

              <div style={styles.debugPanelRow}>
                <span style={styles.debugLabel}>Map Editing (click toggle, then click+drag nodes)</span>
                <button
                  style={{
                    ...styles.debugButton,
                    ...(debugDragMode ? styles.debugButtonActive : {}),
                  }}
                  onClick={() => { setDebugDragMode(!debugDragMode); setDebugDraggingNodeId(null); }}
                >
                  {debugDragMode ? "Node Drag ON (Esc to stop)" : "Toggle Node Drag"}
                </button>
                <button
                  style={styles.debugButton}
                  onClick={() => {
                    onGameCommand({ type: "debug_save_layout" });
                    alert("Map layout saved to server!");
                  }}
                >
                  Save Layout
                </button>
                <button
                  style={styles.debugButton}
                  onClick={() => {
                    onGameCommand({ type: "debug_mirror_nodes" });
                    alert("Blue nodes mirrored to red side!");
                  }}
                >
                  Mirror Blue→Red
                </button>
              </div>

              <div style={styles.debugPanelRow}>
                <span style={styles.debugLabel}>Spawn (click type, then click map)</span>
                {(["worker", "skirmisher", "gunner", "bruiser", "medic"] as const).map((unitType) => (
                  <button
                    key={unitType}
                    style={{
                      ...styles.debugButton,
                      ...(debugSpawnMode === unitType ? styles.debugButtonActive : {}),
                    }}
                    onClick={() => setDebugSpawnMode(debugSpawnMode === unitType ? null : unitType)}
                  >
                    + {unitType.charAt(0).toUpperCase() + unitType.slice(1)}
                  </button>
                ))}
              </div>

              <div style={styles.debugPanelRow}>
                <span style={styles.debugLabel}>Buildings</span>
                {(["barracks", "foundry", "supply_depot", "turret"] as const).map((buildingType) => (
                  <button
                    key={buildingType}
                    style={{
                      ...styles.debugButton,
                      ...(debugSpawnMode === `building:${buildingType}` ? styles.debugButtonActive : {}),
                    }}
                    onClick={() => setDebugSpawnMode(debugSpawnMode === `building:${buildingType}` ? null : `building:${buildingType}`)}
                  >
                    + {BUILDING_LABELS[buildingType]}
                  </button>
                ))}
              </div>

              {debugSpawnMode && (
                <button
                  style={{ ...styles.debugButton, ...styles.debugCancelButton }}
                  onClick={() => setDebugSpawnMode(null)}
                >
                  Cancel Spawn (Esc)
                </button>
              )}
            </div>
            )}
          </div>
        </div>
      </div>

      <div style={styles.bottomBars}>
        {buildMode && selectedBuildingType && (
          <div style={styles.buildBar}>
            <span style={styles.buildLabel}>
              Placing: {BUILDING_LABELS[selectedBuildingType]} ({BUILDING_COSTS[selectedBuildingType]} resource) — Click map to place (Esc to cancel)
            </span>
          </div>
        )}
      </div>

      {/* ── Replay overlay ───────────────────────────────────── */}
      {isReplay && (
        <div style={{
          position: "fixed",
          top: 10,
          right: 10,
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}>
          {/* Version mismatch warning */}
          {replayVersion && gameVersion && replayVersion !== gameVersion && (
            <div style={{
              background: "rgba(20,8,8,0.95)",
              border: `1px solid ${FCT.red}`,
              padding: "6px 14px",
              fontFamily: FCT.mono,
              fontSize: 9,
              letterSpacing: "0.18em",
              color: FCT.red,
              maxWidth: 340,
              lineHeight: 1.5,
            }}>
              ⚠ VERSION MISMATCH — recorded on {replayVersion}, running {gameVersion}.
              Balance values differ; playback will not be accurate.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            background: "rgba(5,6,10,0.85)",
            border: `1px solid ${FCT.amber}`,
            padding: "6px 14px",
            fontFamily: FCT.mono,
            fontSize: 9,
            letterSpacing: "0.28em",
            color: FCT.amber,
            clipPath: "polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)",
          }}>
            ▶ REPLAY
            {replayTotalTicks !== undefined && matchState && (
              <span style={{ marginLeft: 10, color: FCT.inkDim }}>
                {matchState.tick} / {replayTotalTicks} ticks
              </span>
            )}
          </div>
          <button
            onClick={onStopReplay}
            style={{
              background: "rgba(5,6,10,0.85)",
              border: `1px solid ${FCT.lineHi}`,
              padding: "6px 12px",
              fontFamily: FCT.mono,
              fontSize: 9,
              letterSpacing: "0.22em",
              color: FCT.inkDim,
              cursor: "pointer",
              clipPath: "polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)",
            }}
          >
            ✕ Stop
          </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    width: "100vw",
    height: "100vh",
    background: FCT.bg,
    overflow: "hidden",
    alignItems: "stretch",
  },
  gameContainer: {
    flex: 1,
    position: "relative" as const,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
    minHeight: 0,
  },
  canvas: {
    imageRendering: "auto" as const,
    display: "block",
    cursor: "crosshair",
  },
  overlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none" as const,
  },
  phaseOverlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    height: 32,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    fontFamily: FCT.mono,
    fontSize: 12,
    letterSpacing: "0.14em",
    color: FCT.ice,
    fontWeight: 700,
    zIndex: 6,
  },
  scoreboard: {
    position: "absolute" as const,
    top: 32,
    left: 0,
    right: 0,
    height: 56,
    background: "linear-gradient(180deg, rgba(12,16,20,0.92), rgba(12,16,20,0.65))",
    borderBottom: `1px solid ${FCT.lineHi}`,
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    padding: "0 24px",
    gap: 24,
    zIndex: 5,
  },
  infoBar: {
    position: "absolute" as const,
    top: 88,
    left: 0,
    right: 0,
    height: 26,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    fontFamily: FCT.mono,
    fontSize: 11,
    color: FCT.inkDim,
    zIndex: 5,
  },
  bottomBars: {
    width: "100%",
    display: "flex",
    flexDirection: "column" as const,
    flexShrink: 0,
    overflow: "auto",
    maxHeight: 180,
    borderTop: `1px solid ${FCT.line}`,
  },
  trainBar: {
    padding: "8px 16px",
    background: "rgba(0,0,0,0.8)",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "4px",
    pointerEvents: "auto" as const,
    borderTop: `1px solid ${FCT.line}`,
  },
  trainButton: {
    padding: "8px 20px",
    fontSize: "13px",
    fontWeight: 700,
    fontFamily: FCT.display,
    border: `1px solid ${FCT.lineHi}`,
    clipPath: NOTCH_R,
    cursor: "pointer",
    background: FCT.bgPanel,
    color: FCT.ink,
  },
  trainButtonActive: {
    color: FCT.green,
    borderColor: FCT.green,
    background: "rgba(124,255,176,0.1)",
  },
  trainButtonDisabled: {
    color: FCT.inkFaint,
    borderColor: FCT.line,
    background: FCT.bgPanel,
  },
  trainHint: {
    fontSize: "10px",
    color: FCT.red,
    fontFamily: FCT.mono,
  },
  debugPanel: {
    position: "absolute" as const,
    bottom: "8px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(10,10,30,0.92)",
    border: `1px solid ${FCT.line}`,
    borderRadius: "8px",
    padding: "6px 14px",
    maxWidth: "90vw",
    minWidth: "320px",
    pointerEvents: "auto" as const,
    zIndex: 20,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
  },
  debugToggleBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    cursor: "pointer",
    userSelect: "none" as const,
    padding: "2px 0",
  },
  debugToggleArrow: {
    fontSize: "10px",
    color: FCT.inkFaint,
    width: "12px",
    textAlign: "center" as const,
  },
  debugPanelHeader: {
    fontSize: "10px",
    color: FCT.inkFaint,
    textTransform: "uppercase" as const,
    letterSpacing: "1.5px",
    marginBottom: "8px",
    textAlign: "center" as const,
    borderBottom: `1px solid ${FCT.line}`,
    paddingBottom: "6px",
    fontFamily: FCT.mono,
  },
  debugPanelBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  debugPanelRow: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap" as const,
  },
  debugLabel: {
    fontSize: "10px",
    color: FCT.inkFaint,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginRight: "4px",
    whiteSpace: "nowrap" as const,
    fontFamily: FCT.mono,
  },
  debugButton: {
    padding: "4px 10px",
    fontSize: "11px",
    fontFamily: FCT.mono,
    background: "rgba(120,120,140,0.12)",
    color: FCT.inkDim,
    border: `1px solid rgba(120,120,140,0.25)`,
    borderRadius: "4px",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  debugButtonActive: {
    background: "rgba(124,232,255,0.22)",
    color: FCT.ice,
    border: `1px solid ${FCT.ice}`,
    boxShadow: `0 0 6px rgba(124,232,255,0.2)`,
  },
  debugCancelButton: {
    background: "rgba(255,92,243,0.2)",
    color: FCT.red,
    border: `1px solid rgba(255,92,243,0.4)`,
  },
  errorBanner: {
    position: "absolute" as const,
    top: "116px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "6px 14px",
    background: "rgba(180,40,40,0.85)",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    pointerEvents: "auto" as const,
    zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    maxWidth: "500px",
  },
  errorText: {
    fontSize: "12px",
    color: "#ffffff",
    fontFamily: FCT.mono,
    fontWeight: 600,
  },
  errorCloseButton: {
    padding: "2px 6px",
    fontSize: "12px",
    background: "rgba(255,255,255,0.2)",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    lineHeight: 1,
  },
  buildModeButton: {
    padding: "6px 16px",
    fontSize: "12px",
    fontWeight: 700,
    fontFamily: FCT.mono,
    border: `1px solid ${FCT.lineHi}`,
    clipPath: NOTCH_R,
    cursor: "pointer",
    background: FCT.bgPanel,
    color: FCT.ice,
  },
  buildModeButtonActive: {
    background: "rgba(124,232,255,0.15)",
    borderColor: FCT.ice,
  },
  buildBar: {
    padding: "6px 16px",
    background: "rgba(0,0,0,0.85)",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    pointerEvents: "auto" as const,
    borderTop: `1px solid ${FCT.lineHi}`,
  },
  buildLabel: {
    fontSize: "11px",
    color: FCT.inkDim,
    fontFamily: FCT.mono,
  },
  buildConfirmButton: {
    padding: "4px 12px",
    fontSize: "11px",
    background: "rgba(124,255,176,0.3)",
    color: FCT.green,
    border: `1px solid rgba(124,255,176,0.5)`,
    borderRadius: "4px",
    cursor: "pointer",
    fontFamily: FCT.mono,
  },
  buildCancelButton: {
    padding: "4px 12px",
    fontSize: "11px",
    background: "rgba(255,92,243,0.3)",
    color: FCT.red,
    border: `1px solid rgba(255,92,243,0.5)`,
    borderRadius: "4px",
    cursor: "pointer",
    fontFamily: FCT.mono,
  },
  buildTypeBar: {
    padding: "8px 16px",
    background: "rgba(0,0,0,0.9)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    pointerEvents: "auto" as const,
    borderTop: `1px solid ${FCT.line}`,
    flexWrap: "wrap" as const,
  },
  buildTypeLabel: {
    fontSize: "11px",
    color: FCT.ice,
    fontFamily: FCT.mono,
    fontWeight: 700,
  },
  buildTypeButton: {
    padding: "4px 10px",
    fontSize: "10px",
    fontFamily: FCT.mono,
    border: `1px solid ${FCT.lineHi}`,
    clipPath: NOTCH_R,
    cursor: "pointer",
    background: FCT.bgPanel,
    color: FCT.ice,
  },
  buildTypeButtonDisabled: {
    color: FCT.inkFaint,
    borderColor: FCT.line,
    cursor: "not-allowed",
    background: FCT.bgPanel,
  },
  hotkeyMenu: {
    position: "absolute" as const,
    bottom: "8px",
    left: "8px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "3px",
    pointerEvents: "none" as const,
    zIndex: 10,
  },
  selectionInfo: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "3px 8px",
    background: "rgba(0,0,0,0.6)",
    clipPath: HEX_CLIP,
    marginBottom: "2px",
  },
  selectionInfoName: {
    fontSize: "11px",
    fontWeight: 700,
    color: FCT.ice,
    fontFamily: FCT.mono,
    textTransform: "uppercase" as const,
  },
  selectionInfoHp: {
    fontSize: "10px",
    color: FCT.green,
    fontFamily: FCT.mono,
  },
  hotkeyRow: {
    display: "flex",
    gap: "3px",
  },
  hotkeySlot: {
    width: "78px",
    height: "78px",
    background: "rgba(0,0,0,0.78)",
    border: `1px solid ${FCT.line}`,
    clipPath: HEX_CLIP,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    transition: "all 0.1s ease",
  },
  hotkeyFlash: {
    background: "rgba(124,232,255,0.25)",
    border: `1px solid ${FCT.ice}`,
    transform: "scale(1.1)",
  },
  hotkeyLabel: {
    fontSize: "14px",
    fontFamily: FCT.mono,
    color: FCT.ice,
    fontWeight: 700,
    lineHeight: 1,
  },
  hotkeyIcon: {
    fontSize: "20px",
    lineHeight: 1,
  },
  hotkeyName: {
    fontSize: "10px",
    fontFamily: FCT.display,
    color: FCT.ink,
    lineHeight: 1,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  },
  unitQueuePanel: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
  },
  unitQueueButton: {
    padding: "3px 8px",
    fontSize: "10px",
    fontFamily: FCT.mono,
    border: `1px solid ${FCT.lineHi}`,
    clipPath: NOTCH_R,
    cursor: "pointer",
    background: FCT.bgPanel,
    color: FCT.ice,
  },
  unitQueueButtonActive: {
    color: FCT.green,
    borderColor: FCT.green,
    background: "rgba(124,255,176,0.1)",
  },
  unitQueueButtonDisabled: {
    color: FCT.inkFaint,
    borderColor: FCT.line,
    cursor: "not-allowed",
    background: FCT.bgPanel,
  },
  unitQueueCancelButton: {
    padding: "3px 8px",
    fontSize: "10px",
    fontFamily: FCT.mono,
    border: `1px solid rgba(255,92,243,0.4)`,
    clipPath: NOTCH_R,
    cursor: "pointer",
    background: "rgba(255,92,243,0.1)",
    color: FCT.red,
  },
  buildConfirmButtonActive: {
    background: "rgba(124,255,176,0.5)",
  },
};
