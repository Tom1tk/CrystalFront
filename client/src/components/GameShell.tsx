import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Lobby, Player, MatchState, ResourceNodeDisplay, BuildingType, MatchEntity } from "../types";

interface GameShellProps {
  lobby: Lobby;
  player: Player;
  matchState: MatchState | null;
  resourceNodes: ResourceNodeDisplay[];
  onDebugWin: (winner: "player1" | "player2") => void;
  onDebugSpawn: (entityType: string, x: number, y: number, buildingType?: string) => void;
  onGameCommand: (command: {
    type: string;
    entityId?: string;
    entityIds?: string[];
    workerIds?: string[];
    targetX?: number;
    targetY?: number;
    targetEntityId?: string;
    buildingType?: BuildingType;
  }) => void;
  error: string | null;
  onClearError: () => void;
}

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
const MINIMAP_WIDTH = 150;
const MINIMAP_HEIGHT = 40;
const EDGE_SCROLL_THRESHOLD = 50;
const EDGE_SCROLL_SPEED = 3;

const BUILDING_COLORS: Record<BuildingType, string> = {
  barracks: "#4488cc",
  foundry: "#cc6644",
  supply_depot: "#88aa66",
  turret: "#aa8844",
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

  ctx.fillStyle = "rgba(0, 0, 20, 0.85)";
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
      ? (entity.ownerId === undefined ? "#888" : playerColor === "blue" ? "#4488ff" : "#ff4444")
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
}: GameShellProps) {
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
    | "toggle_auto_attack"
    | "unit_stop"
    | "retreat"
    | "fortify"
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
      (e) => e.type === "crystal" && e.ownerId === player.id
    );
    const barracksSelected = selectedEntities.some(
      (e) => e.type === "building" && e.buildingType === "barracks" && e.ownerId === player.id
    );
    const foundrySelected = selectedEntities.some(
      (e) => e.type === "building" && e.buildingType === "foundry" && e.ownerId === player.id
    );
    const hasUnits = selectedEntities.some(
      (e) => e.type !== "building" && e.type !== "crystal" && e.ownerId === player.id
    );

    return [
      { key: "q", action: crystalSelected ? "train_worker" : barracksSelected ? "train_skirmisher" : "none", label: crystalSelected ? "Worker" : barracksSelected ? "Skirmisher" : "", icon: crystalSelected ? "👷" : barracksSelected ? "⚔️" : "" },
      { key: "w", action: barracksSelected ? "train_gunner" : "none", label: barracksSelected ? "Gunner" : "", icon: barracksSelected ? "🔫" : "" },
      { key: "e", action: foundrySelected ? "train_bruiser" : "none", label: foundrySelected ? "Bruiser" : "", icon: foundrySelected ? "🛡️" : "" },
      { key: "r", action: foundrySelected ? "train_medic" : "none", label: foundrySelected ? "Medic" : "", icon: foundrySelected ? "💊" : "" },
      { key: "a", action: hasUnits ? "toggle_auto_attack" : "none", label: hasUnits ? "Attack" : "", icon: hasUnits ? "⚔️" : "" },
      { key: "s", action: hasUnits ? "unit_stop" : "none", label: hasUnits ? "Stop" : "", icon: hasUnits ? "⏹" : "" },
      { key: "d", action: hasUnits ? "retreat" : "none", label: hasUnits ? "Retreat" : "", icon: hasUnits ? "↩️" : "" },
      { key: "f", action: hasUnits ? "fortify" : "none", label: hasUnits ? "Fortify" : "", icon: hasUnits ? "🔧" : "" },
    ];
  }, [selectedEntityIds, matchState, player.id]);

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
  const playerRef = useRef(player);
  const minimapDraggingRef = useRef(false);

  // Death particle system
  const prevEntityIdsRef = useRef<Set<string>>(new Set());
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
    (entity: { ownerId: string }) => entity.ownerId === player.id,
    [player.id]
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
    if (!canvas) return;

    const viewW = canvas.clientWidth;
    const viewH = canvas.clientHeight;
    const mapWidth = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
    const mapHeight = matchState.mapHeight ?? matchState.config?.mapHeight ?? 600;

    const myIdx = matchState.players.findIndex((p) => p?.playerId === player.id);
    const myCrystal = matchState.entities.find((e) => e.type === "crystal" && e.ownerId === player.id);

    if (myCrystal) {
      cameraXRef.current = Math.max(0, Math.min(myCrystal.x - viewW / 2, mapWidth - viewW));
      cameraYRef.current = Math.max(0, Math.min(myCrystal.y - viewH / 2, mapHeight - viewH));
    } else if (myIdx === 0) {
      cameraXRef.current = 0;
      cameraYRef.current = 0;
    } else {
      cameraXRef.current = Math.max(0, mapWidth - viewW);
      cameraYRef.current = 0;
    }

  }, [matchState, player.id]);

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

  // Edge scrolling loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    canvas.addEventListener("mousemove", onMouseMove);
    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
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
        const viewH = canvas.clientHeight;
        const mapHeight = matchState.mapHeight ?? matchState.config?.mapHeight ?? 600;
        cameraXRef.current = Math.max(0, Math.min(fraction * mapWidth - viewW / 2, mapWidth - viewW));
        if (screenY >= minimapY && screenY <= minimapY + MINIMAP_HEIGHT) {
          const yFraction = (screenY - minimapY) / MINIMAP_HEIGHT;
          cameraYRef.current = Math.max(0, Math.min(yFraction * mapHeight - viewH / 2, mapHeight - viewH));
        }
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

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      if (handleMinimapClick(e)) return;

      const worldX = screenX + cameraXRef.current;
      const worldY = screenY;

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
        console.log("[box-select] mousedown at", { screenX, screenY });
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
          if (clickedEntity && clickedEntity.ownerId !== player.id) {
            onGameCommand({
              type: "attack",
              entityId: sid,
              targetEntityId: clickedEntity.id,
            });
            continue;
          }

          // Medic heal friendly unit
          if (selEntity.type === "medic" && clickedEntity && clickedEntity.ownerId === player.id &&
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
              clickedEntity.type === "building" && clickedEntity.ownerId === player.id &&
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
              clickedEntity.type === "building" && clickedEntity.ownerId === player.id &&
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
    [myEntities, selectedEntityId, selectedEntityIds, resourceNodes, onGameCommand, buildMode, selectedBuildingType, myCrystal, matchState, handleMinimapClick, player.id]
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
      const worldY = screenY;
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
      // Enter rally mode with 'R' when a building or crystal is selected
      if (e.key === "r" || e.key === "R") {
        if (selectedEntityId) {
          const entity = matchState?.entities.find((ent) => ent.id === selectedEntityId);
          if (entity && (entity.type === "building" || entity.type === "crystal") && entity.ownerId === player.id) {
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
            return ent && ent.type !== "building" && ent.type !== "crystal" && ent.ownerId === player.id;
          }
        );

        switch (hotkey.action) {
          case "train_worker": {
            // Train worker from selected crystal
            const crystal = selectedIds
              .map((id) => entities.find((ent) => ent.id === id))
              .filter((ent): ent is MatchEntity => ent != null && ent.type === "crystal" && ent.ownerId === player.id);
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
                .find((ent): ent is MatchEntity => ent != null && ent.type === "building" && ent.buildingType === "barracks" && ent.ownerId === player.id);
            } else {
              building = selectedIds
                .map((id) => entities.find((ent) => ent.id === id))
                .find((ent): ent is MatchEntity => ent != null && ent.type === "building" && ent.buildingType === "foundry" && ent.ownerId === player.id);
            }
            if (building) {
              onGameCommand({
                type: "train_unit",
                entityId: building.id,
                targetEntityId: unitType,
              });
            }
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
                  (ent) => ent.type === "building" && ent.ownerId === player.id && ent.health < ent.maxHealth
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
                  (ent) => ent.type !== "building" && ent.type !== "crystal" && ent.ownerId === player.id && ent.health < ent.maxHealth
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
  }, [rallyMode, selectedEntityId, selectedEntityIds, matchState, player.id, hotkeys]);

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
          const worldY = screenY;
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
        console.log("[box-select] mouseup at", { screenX, screenY, dx, dy, dragStart });
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          console.log("[box-select] drag distance > 10, doing box-select");
          const x1 = Math.min(dragStart.x, screenX);
          const y1 = Math.min(dragStart.y, screenY);
          const x2 = Math.max(dragStart.x, screenX);
          const y2 = Math.max(dragStart.y, screenY);

          const worldX1 = x1 + cameraXRef.current;
          const worldY1 = y1;
          const worldX2 = x2 + cameraXRef.current;
          const worldY2 = y2;

          console.log("[box-select] world bounds", { worldX1, worldY1, worldX2, worldY2 });

          const boxSelected = new Set<string>();
          for (const entity of matchState?.entities ?? []) {
            if (entity.ownerId !== player.id) continue;
            if (entity.type === "crystal" || entity.type === "building") continue;
            if (entity.x >= worldX1 && entity.x <= worldX2 && entity.y >= worldY1 && entity.y <= worldY2) {
              boxSelected.add(entity.id);
              console.log("[box-select] included entity", entity.id, entity.type, "at", entity.x, entity.y);
            }
          }

          console.log("[box-select] selected count:", boxSelected.size);
          setSelectedEntityIds(boxSelected);
          setSelectedEntityId(null);
        }
        // Single-click: hit detection
        else {
          const worldX = screenX + cameraXRef.current;
          const worldY = screenY;

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
    [isDragging, dragStart, matchState, player.id]
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
          const viewH = edgeCanvas.clientHeight;
          const mapHeight = ms.mapHeight ?? 600;

          // Minimap drag: update camera while dragging on minimap
          if (minimapDraggingRef.current) {
            const mmX = viewW - MINIMAP_WIDTH - 10;
            const mmY = viewH - MINIMAP_HEIGHT - 10;
            if (pos.y >= mmY && pos.y <= mmY + MINIMAP_HEIGHT) {
              const yFraction = Math.max(0, Math.min(1, (pos.y - mmY) / MINIMAP_HEIGHT));
              cameraYRef.current = Math.max(0, Math.min(yFraction * mapHeight - viewH / 2, mapHeight - viewH));
            }
            const xFraction = Math.max(0, Math.min(1, (pos.x - mmX) / MINIMAP_WIDTH));
            const mapWidth = ms.mapWidth ?? 6000;
            cameraXRef.current = Math.max(0, Math.min(xFraction * mapWidth - viewW / 2, mapWidth - viewW));
          }

          // Edge scrolling (only when not dragging minimap)
          if (!minimapDraggingRef.current) {
            let dx = 0;
            if (pos.x < EDGE_SCROLL_THRESHOLD) dx = -EDGE_SCROLL_SPEED;
            else if (pos.x > viewW - EDGE_SCROLL_THRESHOLD) dx = EDGE_SCROLL_SPEED;
            if (dx !== 0) {
              const mapWidth = ms.mapWidth ?? 6000;
              cameraXRef.current = Math.max(0, Math.min(mapWidth - viewW, cameraXRef.current + dx));
            }
            let dy = 0;
            if (pos.y < EDGE_SCROLL_THRESHOLD) dy = -EDGE_SCROLL_SPEED;
            else if (pos.y > viewH - EDGE_SCROLL_THRESHOLD) dy = EDGE_SCROLL_SPEED;
            if (dy !== 0) {
              cameraYRef.current = Math.max(0, Math.min(mapHeight - viewH, cameraYRef.current + dy));
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
          const prevPos = prevEntitiesRef.current.get(prevId);
          const deadEntity = ms.entities.find((e: MatchEntity) => e.id === prevId);
          const isCrystal = deadEntity?.type === "crystal";
          const px = prevPos?.x ?? (deadEntity?.x ?? 0);
          const py = prevPos?.y ?? (deadEntity?.y ?? 0);
          const color = isCrystal ? "#4488ff" : "#ff6633";
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
    const myCrystal = entities.find((e) => e.type === "crystal" && e.ownerId === player.id);

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, cssW, cssH);

    const cameraX = cameraXRef.current;
    const cameraY = cameraYRef.current;
    const mapWidth = matchState.mapWidth ?? matchState.config?.mapWidth ?? 6000;
    const mapHeight = matchState.mapHeight ?? matchState.config?.mapHeight ?? 600;

    const getTeamColor = (ownerId: string) => {
      const pIdx = matchState.players.findIndex((p) => p?.playerId === ownerId);
      return pIdx === 0 ? "#4488ff" : "#ff4444";
    };

    const laneTop = mapHeight * 0.2;
    const laneBottom = mapHeight * 0.8;
    const combatZoneTop = mapHeight * 0.3;
    const combatZoneBottom = mapHeight * 0.7;

    ctx.save();
    ctx.translate(-cameraX, -cameraY);

    // Lane background
    ctx.fillStyle = "#111122";
    ctx.fillRect(0, laneTop, mapWidth, laneBottom - laneTop);

    // Combat zone
    const combatLeft = mapWidth * 0.25;
    const combatRight = mapWidth * 0.75;
    ctx.fillStyle = "#151530";
    ctx.fillRect(combatLeft, combatZoneTop, combatRight - combatLeft, combatZoneBottom - combatZoneTop);

    // Build zones
    ctx.fillStyle = "rgba(68, 136, 255, 0.05)";
    ctx.fillRect(0, 0, mapWidth * 0.2, mapHeight);
    ctx.fillStyle = "rgba(255, 68, 68, 0.05)";
    ctx.fillRect(mapWidth * 0.8, 0, mapWidth * 0.2, mapHeight);

    // Lane lines
    ctx.strokeStyle = "#222244";
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
    ctx.strokeStyle = "#1a1a3a";
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
      ctx.fillStyle = "rgba(204, 170, 68, 0.15)";
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
      const localIsMyTeam = entity.ownerId === player.id;
      const localIsSelected = entity.id === selectedEntityId;
      const localIsBuilding = entity.type === "building" || entity.type === "crystal";

      if (localIsBuilding) {
        const w = entity.radius * 2;
        const h = entity.radius * 2;
        const bx = entity.x - w / 2;
        const by = entity.y - h / 2;

        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(bx + 2, by + 2, w, h);
        const color = entity.buildingType ? BUILDING_COLORS[entity.buildingType] : entity.color;

        // Dark background for building body
        ctx.fillStyle = "rgba(20,20,20,0.6)";
        ctx.fillRect(bx, by, w, h);

        // Health fill from bottom to top
        const bHealthPct = entity.health / entity.maxHealth;
        const bFillH = h * bHealthPct;
        const bFillColor = getTeamColor(entity.ownerId);
        ctx.fillStyle = bFillColor;
        ctx.fillRect(bx, by + h - bFillH, w, bFillH);

        // Overlay team color at 40% opacity
        ctx.fillStyle = color.replace(")", ",0.4)").replace("rgb", "rgba");
        ctx.fillRect(bx, by, w, h);

        if (entity.constructionProgress < 100) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(bx, by, w, h);
          const progW = w * (entity.constructionProgress / 100);
          ctx.fillStyle = color;
          ctx.fillRect(bx, by, progW, h);
        }

        if (entity.repairTargetId && entity.health < entity.maxHealth) {
          const repairPct = (entity.repairProgress ?? 0) / Math.max(1, entity.maxHealth - entity.health);
          ctx.fillStyle = "rgba(68, 204, 68, 0.4)";
          ctx.fillRect(bx, by, w * repairPct, h);
        }

        if (localIsSelected) {
          ctx.strokeStyle = "#ffff44";
          ctx.lineWidth = 2;
          ctx.strokeRect(bx - 3, by - 3, w + 6, h + 6);
        }

        ctx.strokeStyle = localIsMyTeam ? "rgba(100,150,255,0.6)" : "rgba(255,100,100,0.6)";
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, w, h);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = entity.type === "crystal" ? "HQ" : (entity.buildingType ? BUILDING_LABELS[entity.buildingType] : "??");
        ctx.fillText(label, entity.x, entity.y - 4);

        if (entity.constructionProgress < 100) {
          const barWidth = w;
          const barHeight = 4;
          const barY = by - 8;
          ctx.fillStyle = "#333";
          ctx.fillRect(bx, barY, barWidth, barHeight);
          ctx.fillStyle = "#44cc44";
          ctx.fillRect(bx, barY, barWidth * (entity.constructionProgress / 100), barHeight);
          const workerCount = entity.buildWorkerIds?.length ?? 0;
          if (workerCount > 0) {
            ctx.fillStyle = "#aaa";
            ctx.font = "8px monospace";
            ctx.textAlign = "center";
            ctx.fillText(`${workerCount}W`, entity.x, barY - 3);
          }
        }

        if (entity.health < entity.maxHealth) {
          const barWidth = w;
          const barHeight = 4;
          const barY = by + h + 4;
          const healthPct = entity.health / entity.maxHealth;
          ctx.fillStyle = "#333";
          ctx.fillRect(bx, barY, barWidth, barHeight);
          ctx.fillStyle = getTeamColor(entity.ownerId);
          ctx.fillRect(bx, barY, barWidth * healthPct, barHeight);
        }

        if (entity.productionQueue.length > 0) {
          const firstItem = entity.productionQueue[0];
          const queueBarWidth = w;
          const queueBarHeight = 4;
          const queueBarY = by + h + 10;
          ctx.fillStyle = "#333";
          ctx.fillRect(bx, queueBarY, queueBarWidth, queueBarHeight);
          const prodPct = 1 - firstItem.remainingTicks / firstItem.buildTime;
          ctx.fillStyle = "#88aaff";
          ctx.fillRect(bx, queueBarY, queueBarWidth * prodPct, queueBarHeight);
          ctx.fillStyle = "#aaa";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.fillText(`${firstItem.unitType}: ${Math.ceil(firstItem.remainingTicks / 10)}s`, entity.x, queueBarY + 12);
        }
      } else {
        ctx.beginPath();
        ctx.arc(entity.x + 2, entity.y + 2, entity.radius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fill();

        // Dark background fill (empty/void area)
        ctx.beginPath();
        ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20,20,20,0.6)";
        ctx.fill();

        // Health fill from bottom to top
        const healthPct = entity.health / entity.maxHealth;
        const fillR = entity.radius;
        const fillBottom = entity.y + fillR;
        const fillHeight = fillR * 2 * healthPct;
        const fillTop = fillBottom - fillHeight;
        const fillColor = getTeamColor(entity.ownerId);
        ctx.save();
        ctx.beginPath();
        ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = fillColor;
        ctx.fillRect(entity.x - fillR, fillTop, fillR * 2, fillHeight);
        ctx.restore();

        if (localIsSelected || selectedEntityIdsRef.current.has(entity.id)) {
          ctx.beginPath();
          ctx.arc(entity.x, entity.y, entity.radius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "#ffff44";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
        ctx.strokeStyle = localIsMyTeam ? "rgba(100,150,255,0.6)" : "rgba(255,100,100,0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Team color indicator on top of health fill
        ctx.beginPath();
        ctx.arc(entity.x, entity.y - entity.radius * 0.35, 2, 0, Math.PI * 2);
        ctx.fillStyle = entity.color;
        ctx.fill();

        if (entity.health < entity.maxHealth) {
          const barWidth = entity.radius * 2;
          const barHeight = 4;
          const barX = entity.x - entity.radius;
          const barY = entity.y - entity.radius - 8;
          const healthPct = entity.health / entity.maxHealth;
          ctx.fillStyle = "#333";
          ctx.fillRect(barX, barY, barWidth, barHeight);
          ctx.fillStyle = getTeamColor(entity.ownerId);
          ctx.fillRect(barX, barY, barWidth * healthPct, barHeight);
        }

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = entity.type === "crystal" ? "C" : entity.type === "worker" ? "W" : entity.type === "resource_node" ? "R" : entity.type === "skirmisher" ? "S" : entity.type === "gunner" ? "G" : entity.type === "bruiser" ? "B" : entity.type === "medic" ? "M" : "?";
        ctx.fillText(label, entity.x, entity.y);
      }
    }

    // Rally point markers
    for (const entity of entities) {
      if (entity.rallyPoint) {
        const rx = entity.rallyPoint.x;
        const ry = entity.rallyPoint.y;
        // Draw rally point marker - orange diamond
        ctx.save();
        ctx.translate(rx, ry);
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.rect(-5, -5, 10, 10);
        ctx.fillStyle = "rgba(255, 180, 50, 0.8)";
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
      const isBlue = player.color === "blue";
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
        player.color,
        minimapX,
        minimapY
      );
    }

    // Phase overlay
    if (matchState) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, cssW, 32);
      ctx.fillStyle = "#8888ff";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const phaseLabel = matchState.phase === "spawn" ? "SPAWNING" : matchState.phase === "playing" ? "IN GAME" : "ENDED";
      ctx.fillText(`[${phaseLabel}] Tick: ${matchState.tick}`, cssW / 2, 16);
      ctx.fillStyle = "#666";
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`Match: ${matchState.id.slice(0, 8)}`, cssW - 10, 16);
    }

    ctx.restore();
  }



  const opponent = lobby.players.find((p) => p?.id !== player.id);
  const opponentColor = opponent?.color === "blue" ? "#4488ff" : "#ff4444";
  const myColor = player.color === "blue" ? "#4488ff" : "#ff4444";

  const myEconomy = (() => {
    if (!matchState) return null;
    const myIdx = matchState.players.findIndex((p) => p?.playerId === player.id);
    if (myIdx < 0) return null;
    return matchState.economy[myIdx] ?? null;
  })();

  const opponentEconomy = (() => {
    if (!matchState) return null;
    const myIdx = matchState.players.findIndex((p) => p?.playerId === player.id);
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
      <div ref={containerRef} style={styles.gameContainer}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
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
          <div style={styles.scoreboard}>
            <div style={{ ...styles.scorePlayer, color: myColor }}>
              <span style={{ fontSize: "18px", fontWeight: 700 }}>{player.username}</span>
              <span style={{ ...styles.scoreNum, color: "#8888ff" }}>{player.score}</span>
            </div>
            <div style={styles.vs}>VS</div>
            <div style={{ ...styles.scorePlayer, color: opponentColor }}>
              <span style={{ ...styles.scoreNum, color: "#8888ff" }}>{opponent?.score ?? 0}</span>
              <span style={{ fontSize: "18px", fontWeight: 700 }}>{opponent?.username ?? "..."}</span>
            </div>
          </div>

          <div style={styles.infoBar}>
            <div style={styles.economyDisplay}>
              <span style={styles.resourceIcon}>⛏</span>
              <span style={styles.resourceValue}>{myEconomy?.resources ?? 0}</span>
              <span style={styles.supplyIcon}>📦</span>
              <span style={styles.supplyValue}>
                {myEconomy?.supply ?? 0}/{myEconomy?.maxSupply ?? 0}
              </span>
            </div>
            <span style={styles.infoText}>
              {buildMode && selectedBuildingType
                ? `Placing ${BUILDING_LABELS[selectedBuildingType]} — click map to place, Esc to cancel`
                : isMultiSelect
                  ? `Selected ${selectedEntityIds.size} units`
                  : selectedEntityId
                    ? selectedEntity?.type === "crystal"
                      ? selectedEntity?.ownerId === player.id
                        ? `HQ \u2022 HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth} \u2022 Q: Worker`
                        : "Enemy HQ"
                      : selectedEntity?.type === "building"
                        ? `${selectedEntity.buildingType || "Building"} \u2022 HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth}${selectedEntity?.constructionProgress !== undefined && selectedEntity.constructionProgress < 100
                          ? ` \u2022 Building: ${Math.floor(selectedEntity.constructionProgress)}%`
                          : selectedEntity?.productionQueue.length > 0
                            ? ` \u2022 ${selectedEntity.productionQueue[0]?.unitType}: ${Math.ceil((selectedEntity.productionQueue[0]?.remainingTicks ?? 0) / 10)}s`
                            : ""}`
                        : selectedEntity?.ownerId === player.id
                          ? `${selectedEntity.type} \u2022 HP: ${Math.floor(selectedEntity.health)}/${selectedEntity.maxHealth}${selectedEntity.autoAttackEnabled ? " \u2022 AA:ON" : ""}`
                          : `Enemy ${selectedEntity?.type}`
                    : "Click units to select, drag to box-select"}
            </span>
            <span style={styles.infoText}>Tick: {matchState?.tick ?? 0}</span>
          </div>

          {/* Hotkey Menu - QWER/ASDF Grid */}
          {showHotkeyMenu && (
            <div style={styles.hotkeyMenu}>
              {/* Selection info strip */}
              {selectedEntityId && selectedEntity && selectedEntity.ownerId === player.id && (
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
                      player.id === lobby.players[0]?.id ? "player1" : "player2"
                    )
                  }
                >
                  Simulate My Win
                </button>
                <button
                  style={styles.debugButton}
                  onClick={() =>
                    onDebugWin(
                      player.id === lobby.players[0]?.id ? "player2" : "player1"
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
              Placing: {BUILDING_LABELS[selectedBuildingType]} ({BUILDING_COSTS[selectedBuildingType]} resource)
            </span>
            <span style={styles.buildLabel}>Click map to place</span>
            <button style={styles.buildCancelButton} onClick={handleCancelBuild}>
              Cancel
            </button>
          </div>
        )}

        {hasSelectedWorkers && !buildMode && (
          <div style={styles.buildTypeBar}>
            <span style={styles.buildTypeLabel}>
              {selectedWorkers.length} worker{selectedWorkers.length > 1 ? 's' : ''} — Build:
            </span>
            <button
              style={{
                ...styles.buildTypeButton,
                ...(canBuildSupplyDepot ? {} : styles.buildTypeButtonDisabled),
              }}
              onClick={() => handleBuildClick("supply_depot")}
              disabled={!canBuildSupplyDepot}
            >
              Supply Depot (50)
            </button>
            <button
              style={{
                ...styles.buildTypeButton,
                ...(canBuildBarracks ? {} : styles.buildTypeButtonDisabled),
              }}
              onClick={() => handleBuildClick("barracks")}
              disabled={!canBuildBarracks}
            >
              Barracks (75)
            </button>
            <button
              style={{
                ...styles.buildTypeButton,
                ...(canBuildFoundry ? {} : styles.buildTypeButtonDisabled),
              }}
              onClick={() => handleBuildClick("foundry")}
              disabled={!canBuildFoundry}
            >
              Foundry (100)
            </button>
            <button
              style={{
                ...styles.buildTypeButton,
                ...(canBuildTurret ? {} : styles.buildTypeButtonDisabled),
              }}
              onClick={() => handleBuildClick("turret")}
              disabled={!canBuildTurret}
            >
              Turret (60)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    width: "100vw",
    height: "100vh",
    background: "#0a0a1a",
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
  scoreboard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "24px",
    padding: "8px 16px",
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(4px)",
  },
  scorePlayer: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "16px",
  },
  vs: {
    fontSize: "14px",
    color: "#666",
    fontWeight: 600,
  },
  scoreNum: {
    fontSize: "20px",
    fontWeight: 700,
    minWidth: "24px",
  },
  infoBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 16px",
    background: "rgba(0,0,0,0.5)",
  },
  economyDisplay: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  resourceIcon: {
    fontSize: "14px",
    color: "#ccaa44",
  },
  resourceValue: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#ccaa44",
    fontFamily: "monospace",
  },
  supplyIcon: {
    fontSize: "14px",
    color: "#88aa88",
  },
  supplyValue: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#88aa88",
    fontFamily: "monospace",
  },
  infoText: {
    fontSize: "11px",
    color: "#888",
    fontFamily: "monospace",
  },
  bottomBars: {
    width: "100%",
    display: "flex",
    flexDirection: "column" as const,
    flexShrink: 0,
    overflow: "auto",
    maxHeight: 180,
  },
  trainBar: {
    padding: "8px 16px",
    background: "rgba(0,0,0,0.8)",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "4px",
    pointerEvents: "auto" as const,
    borderTop: "1px solid rgba(100,100,200,0.15)",
  },
  trainButton: {
    padding: "8px 20px",
    fontSize: "13px",
    fontWeight: 700,
    fontFamily: "monospace",
    border: "1px solid rgba(100,100,200,0.4)",
    borderRadius: "6px",
    cursor: "pointer",
    background: "rgba(30,30,60,0.9)",
    color: "#aaa",
    backdropFilter: "blur(4px)",
  },
  trainButtonActive: {
    color: "#44cc44",
    borderColor: "rgba(68,204,68,0.6)",
    background: "rgba(30,60,30,0.9)",
  },
  trainButtonDisabled: {
    color: "#666",
    borderColor: "rgba(100,100,100,0.2)",
  },
  trainHint: {
    fontSize: "10px",
    color: "#884444",
    fontFamily: "monospace",
  },
  debugPanel: {
    position: "absolute" as const,
    bottom: "8px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(10, 10, 30, 0.92)",
    backdropFilter: "blur(8px)",
    border: "1px solid rgba(100, 100, 200, 0.25)",
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
    color: "#666",
    width: "12px",
    textAlign: "center" as const,
  },
  debugPanelHeader: {
    fontSize: "10px",
    color: "#666",
    textTransform: "uppercase" as const,
    letterSpacing: "1.5px",
    marginBottom: "8px",
    textAlign: "center" as const,
    borderBottom: "1px solid rgba(100, 100, 200, 0.15)",
    paddingBottom: "6px",
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
    color: "#555",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginRight: "4px",
    whiteSpace: "nowrap" as const,
  },
  debugButton: {
    padding: "4px 10px",
    fontSize: "11px",
    background: "rgba(100, 100, 100, 0.15)",
    color: "#888",
    border: "1px solid rgba(100, 100, 100, 0.25)",
    borderRadius: "4px",
    cursor: "pointer",
    fontFamily: "monospace",
    transition: "all 0.15s ease",
  },
  debugButtonActive: {
    background: "rgba(100, 200, 255, 0.25)",
    color: "#88ddff",
    border: "1px solid rgba(100, 200, 255, 0.5)",
    boxShadow: "0 0 6px rgba(100, 200, 255, 0.2)",
  },
  debugCancelButton: {
    background: "rgba(255, 100, 100, 0.2)",
    color: "#ff8888",
    border: "1px solid rgba(255, 100, 100, 0.4)",
  },
  errorBanner: {
    position: "absolute" as const,
    top: "40px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "8px 16px",
    background: "rgba(180,40,40,0.9)",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    pointerEvents: "auto" as const,
    zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
  },
  errorText: {
    fontSize: "12px",
    color: "#ffffff",
    fontFamily: "monospace",
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
    fontFamily: "monospace",
    border: "1px solid rgba(100,150,255,0.4)",
    borderRadius: "4px",
    cursor: "pointer",
    background: "rgba(30,30,60,0.9)",
    color: "#88aaff",
  },
  buildModeButtonActive: {
    background: "rgba(30,60,100,0.9)",
    borderColor: "rgba(100,150,255,0.8)",
  },
  buildBar: {
    padding: "6px 16px",
    background: "rgba(0,0,0,0.85)",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    pointerEvents: "auto" as const,
    borderTop: "1px solid rgba(100,150,255,0.15)",
  },
  buildLabel: {
    fontSize: "11px",
    color: "#aaa",
    fontFamily: "monospace",
  },
  buildConfirmButton: {
    padding: "4px 12px",
    fontSize: "11px",
    background: "rgba(68,204,68,0.3)",
    color: "#44cc44",
    border: "1px solid rgba(68,204,68,0.5)",
    borderRadius: "4px",
    cursor: "pointer",
    fontFamily: "monospace",
  },
  buildCancelButton: {
    padding: "4px 12px",
    fontSize: "11px",
    background: "rgba(200,68,68,0.3)",
    color: "#cc6644",
    border: "1px solid rgba(200,68,68,0.5)",
    borderRadius: "4px",
    cursor: "pointer",
    fontFamily: "monospace",
  },
  buildTypeBar: {
    padding: "8px 16px",
    background: "rgba(0,0,0,0.9)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    pointerEvents: "auto" as const,
    borderTop: "1px solid rgba(100,150,255,0.2)",
    flexWrap: "wrap" as const,
  },
  buildTypeLabel: {
    fontSize: "11px",
    color: "#88aaff",
    fontFamily: "monospace",
    fontWeight: 700,
  },
  buildTypeButton: {
    padding: "4px 10px",
    fontSize: "10px",
    fontFamily: "monospace",
    border: "1px solid rgba(100,150,255,0.4)",
    borderRadius: "4px",
    cursor: "pointer",
    background: "rgba(30,30,60,0.9)",
    color: "#88aaff",
  },
  buildTypeButtonDisabled: {
    color: "#555",
    borderColor: "rgba(100,100,100,0.2)",
    cursor: "not-allowed",
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
    borderRadius: "4px",
    marginBottom: "2px",
  },
  selectionInfoName: {
    fontSize: "11px",
    fontWeight: 700,
    color: "#88aaff",
    fontFamily: "monospace",
    textTransform: "uppercase" as const,
  },
  selectionInfoHp: {
    fontSize: "10px",
    color: "#44cc44",
    fontFamily: "monospace",
  },
  hotkeyRow: {
    display: "flex",
    gap: "3px",
  },
  hotkeySlot: {
    width: "60px",
    height: "60px",
    background: "rgba(0,0,0,0.75)",
    border: "1px solid transparent",
    borderRadius: "4px",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    transition: "all 0.1s ease",
  },
  hotkeyFlash: {
    background: "rgba(100,150,255,0.4)",
    borderColor: "rgba(100,150,255,0.8)",
    transform: "scale(1.1)",
  },
  hotkeyLabel: {
    fontSize: "11px",
    fontFamily: "monospace",
    color: "#88aaff",
    fontWeight: 700,
    lineHeight: 1,
  },
  hotkeyIcon: {
    fontSize: "16px",
    lineHeight: 1,
  },
  hotkeyName: {
    fontSize: "8px",
    fontFamily: "monospace",
    color: "#6688cc",
    lineHeight: 1,
    textTransform: "uppercase" as const,
  },
  unitQueuePanel: {
    display: "flex",
    gap: "6px",
    alignItems: "center",
  },
  unitQueueButton: {
    padding: "3px 8px",
    fontSize: "10px",
    fontFamily: "monospace",
    border: "1px solid rgba(100,150,255,0.4)",
    borderRadius: "4px",
    cursor: "pointer",
    background: "rgba(30,30,60,0.9)",
    color: "#88aaff",
  },
  unitQueueButtonActive: {
    color: "#44cc44",
    borderColor: "rgba(68,204,68,0.6)",
    background: "rgba(30,60,30,0.9)",
  },
  unitQueueButtonDisabled: {
    color: "#555",
    borderColor: "rgba(100,100,100,0.2)",
    cursor: "not-allowed",
  },
  unitQueueCancelButton: {
    padding: "3px 8px",
    fontSize: "10px",
    fontFamily: "monospace",
    border: "1px solid rgba(200,68,68,0.4)",
    borderRadius: "4px",
    cursor: "pointer",
    background: "rgba(60,30,30,0.9)",
    color: "#cc6644",
  },
  buildConfirmButtonActive: {
    background: "rgba(68,204,68,0.5)",
  },
};
