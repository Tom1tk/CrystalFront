import { useCallback, useEffect, useRef, useState } from "react";
import type { Lobby, Player, MatchState, ResourceNodeDisplay, BuildingType } from "../types";

interface GameShellProps {
  lobby: Lobby;
  player: Player;
  matchState: MatchState | null;
  resourceNodes: ResourceNodeDisplay[];
  onDebugWin: (winner: "player1" | "player2") => void;
  onGameCommand: (command: {
    type: string;
    entityId?: string;
    targetX?: number;
    targetY?: number;
    targetEntityId?: string;
    buildingType?: BuildingType;
  }) => void;
}

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

const UNIT_COSTS: Record<string, { cost: number; supplyCost: number }> = {
  skirmisher: { cost: 50, supplyCost: 1 },
  gunner: { cost: 75, supplyCost: 1 },
  bruiser: { cost: 100, supplyCost: 2 },
  medic: { cost: 60, supplyCost: 1 },
};

export default function GameShell({
  lobby,
  player,
  matchState,
  resourceNodes,
  onDebugWin,
  onGameCommand,
}: GameShellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [buildMode, setBuildMode] = useState(false);
  const [selectedBuildingType, setSelectedBuildingType] = useState<BuildingType | null>(null);
  const [showUnitQueue, setShowUnitQueue] = useState(false);

  const isMyEntity = useCallback(
    (entity: { ownerId: string }) => entity.ownerId === player.id,
    [player.id]
  );

  const myEntities = matchState?.entities.filter(isMyEntity) ?? [];
  const myCrystal = myEntities.find((e) => e.type === "crystal");

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const worldX = x * scaleX;
      const worldY = y * scaleY;

      // Build mode: place building
      if (buildMode && selectedBuildingType && myCrystal) {
        onGameCommand({
          type: "build",
          entityId: myCrystal.id,
          buildingType: selectedBuildingType,
          targetX: worldX,
          targetY: worldY,
        });
        setBuildMode(false);
        setSelectedBuildingType(null);
        return;
      }

      // Check if clicking on a resource node
      let clickedNode: ResourceNodeDisplay | null = null;
      for (const node of resourceNodes) {
        const dx = worldX - node.x;
        const dy = worldY - node.y;
        if (Math.sqrt(dx * dx + dy * dy) <= node.radius) {
          clickedNode = node;
          break;
        }
      }

      // Check if clicking on any entity (mine or enemy)
      let clickedEntityId: string | null = null;
      let clickedEntity: typeof myEntities[0] | undefined;
      for (const entity of matchState?.entities ?? []) {
        const dx = worldX - entity.x;
        const dy = worldY - entity.y;
        const hitRadius = entity.type === "building" ? 22 : entity.radius;
        if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) {
          clickedEntityId = entity.id;
          clickedEntity = entity;
          break;
        }
      }

      if (clickedEntity) {
        if (clickedEntity.type === "building") {
          setSelectedEntityId(clickedEntity.id);
          onGameCommand({ type: "select", entityId: clickedEntity.id });
        } else if (clickedEntity.type === "crystal") {
          setSelectedEntityId(clickedEntity.id);
          onGameCommand({ type: "select", entityId: clickedEntity.id });
        } else if (clickedEntity.type === "worker") {
          if (clickedNode) {
            onGameCommand({
              type: "gather",
              entityId: clickedEntity.id,
              targetEntityId: clickedNode.id,
            });
          } else {
            setSelectedEntityId(clickedEntity.id);
            onGameCommand({ type: "select", entityId: clickedEntity.id });
          }
        } else {
          setSelectedEntityId(clickedEntity.id);
          onGameCommand({ type: "select", entityId: clickedEntity.id });
        }
      } else if (clickedNode && selectedEntityId) {
        const selectedEntity = myEntities.find((e) => e.id === selectedEntityId);
        if (selectedEntity?.type === "worker") {
          onGameCommand({
            type: "gather",
            entityId: selectedEntityId,
            targetEntityId: clickedNode.id,
          });
          setSelectedEntityId(null);
        }
      } else {
        if (selectedEntityId) {
          const selectedEntity = myEntities.find((e) => e.id === selectedEntityId);
          if (selectedEntity?.type === "worker") {
            // Check if clicking on damaged building for repair
            const damagedBuilding = (matchState?.entities ?? []).find(
              (ent) => ent.type === "building" && ent.health < ent.maxHealth && ent.repairTargetId === undefined
            );
            if (damagedBuilding) {
              const dx = worldX - damagedBuilding.x;
              const dy = worldY - damagedBuilding.y;
              if (Math.sqrt(dx * dx + dy * dy) <= 22) {
                onGameCommand({
                  type: "repair",
                  entityId: selectedEntityId,
                  targetEntityId: damagedBuilding.id,
                });
                setSelectedEntityId(null);
                return;
              }
            }
            onGameCommand({
              type: "move",
              entityId: selectedEntityId,
              targetX: worldX,
              targetY: worldY,
            });
            setSelectedEntityId(null);
          } else {
            onGameCommand({
              type: "move",
              entityId: selectedEntityId,
              targetX: worldX,
              targetY: worldY,
            });
            setSelectedEntityId(null);
          }
        }
      }
    },
    [myEntities, selectedEntityId, resourceNodes, onGameCommand, buildMode, selectedBuildingType, myCrystal, matchState]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      setHoverPos({
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      });
    },
    []
  );

  const handleTrainWorker = useCallback(() => {
    if (myCrystal) {
      onGameCommand({ type: "train_worker", entityId: myCrystal.id });
    }
  }, [myCrystal, onGameCommand]);

  const handleBuildClick = useCallback(
    (type: BuildingType) => {
      setSelectedBuildingType(type);
    },
    []
  );

  const handleCancelBuild = useCallback(() => {
    setBuildMode(false);
    setSelectedBuildingType(null);
    setShowUnitQueue(false);
  }, []);

  // Draw the game
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, width, height);

    const laneTop = height * 0.2;
    const laneBottom = height * 0.8;
    const combatZoneTop = height * 0.3;
    const combatZoneBottom = height * 0.7;

    ctx.fillStyle = "#111122";
    ctx.fillRect(0, laneTop, width, laneBottom - laneTop);

    const combatLeft = width * 0.25;
    const combatRight = width * 0.75;
    ctx.fillStyle = "#151530";
    ctx.fillRect(combatLeft, combatZoneTop, combatRight - combatLeft, combatZoneBottom - combatZoneTop);

    const blueBuildZoneLeft = 0;
    const blueBuildZoneRight = width * 0.3;
    ctx.fillStyle = "rgba(68, 136, 255, 0.05)";
    ctx.fillRect(blueBuildZoneLeft, 0, blueBuildZoneRight - blueBuildZoneLeft, height);

    const redBuildZoneLeft = width * 0.7;
    const redBuildZoneRight = width;
    ctx.fillStyle = "rgba(255, 68, 68, 0.05)";
    ctx.fillRect(redBuildZoneLeft, 0, redBuildZoneRight - redBuildZoneLeft, height);

    ctx.strokeStyle = "#222244";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, laneTop);
    ctx.lineTo(width, laneTop);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, laneBottom);
    ctx.lineTo(width, laneBottom);
    ctx.stroke();

    ctx.strokeStyle = "#1a1a3a";
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(width / 2, laneTop);
    ctx.lineTo(width / 2, laneBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw resource nodes
    for (const node of resourceNodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(204, 170, 68, 0.15)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      const depletion = node.remaining / node.capacity;
      ctx.fillStyle = `rgba(204, 170, 68, ${0.3 + depletion * 0.7})`;
      ctx.fill();
      ctx.strokeStyle = "#ccaa44";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${Math.floor(node.remaining)}`, node.x, node.y);
    }

    // Draw entities
    const entities = matchState?.entities ?? [];
    for (const entity of entities) {
      const isMyTeam = entity.ownerId === player.id;
      const isSelected = entity.id === selectedEntityId;
      const isBuilding = entity.type === "building";
      const hitRadius = isBuilding ? 22 : entity.radius;

      // Building rendering
      if (isBuilding) {
        const w = entity.radius * 2;
        const h = entity.radius * 2;
        const bx = entity.x - w / 2;
        const by = entity.y - h / 2;

        // Building shadow
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(bx + 2, by + 2, w, h);

        // Building body
        const color = entity.buildingType ? BUILDING_COLORS[entity.buildingType] : entity.color;
        ctx.fillStyle = color;
        ctx.fillRect(bx, by, w, h);

        // Construction progress overlay
        if (entity.constructionProgress < 100) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(bx, by, w, h);
          const progW = w * (entity.constructionProgress / 100);
          ctx.fillStyle = color;
          ctx.fillRect(bx, by, progW, h);
        }

        // Repair progress overlay
        if (entity.repairTargetId && entity.health < entity.maxHealth) {
          const repairPct = entity.repairProgress / (entity.maxHealth - entity.health);
          ctx.fillStyle = "rgba(68, 204, 68, 0.4)";
          ctx.fillRect(bx, by, w * repairPct, h);
        }

        // Selection ring
        if (isSelected) {
          ctx.strokeStyle = "#ffff44";
          ctx.lineWidth = 2;
          ctx.strokeRect(bx - 3, by - 3, w + 6, h + 6);
        }

        // Team border
        ctx.strokeStyle = isMyTeam ? "rgba(100,150,255,0.6)" : "rgba(255,100,100,0.6)";
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, w, h);

        // Building label
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = entity.buildingType ? BUILDING_LABELS[entity.buildingType] : "??";
        ctx.fillText(label, entity.x, entity.y - 4);

        // Construction progress bar
        if (entity.constructionProgress < 100) {
          const barWidth = w;
          const barHeight = 4;
          const barY = by - 8;
          ctx.fillStyle = "#333";
          ctx.fillRect(bx, barY, barWidth, barHeight);
          ctx.fillStyle = "#44cc44";
          ctx.fillRect(bx, barY, barWidth * (entity.constructionProgress / 100), barHeight);
        }

        // Health bar
        if (entity.health < entity.maxHealth) {
          const barWidth = w;
          const barHeight = 4;
          const barY = by + h + 4;
          const healthPct = entity.health / entity.maxHealth;
          ctx.fillStyle = "#333";
          ctx.fillRect(bx, barY, barWidth, barHeight);
          ctx.fillStyle =
            healthPct > 0.5
              ? "#44cc44"
              : healthPct > 0.25
                ? "#cccc44"
                : "#cc4444";
          ctx.fillRect(bx, barY, barWidth * healthPct, barHeight);
        }

        // Production queue indicator
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
        // Non-building entity rendering
        ctx.beginPath();
        ctx.arc(entity.x + 2, entity.y + 2, entity.radius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fill();

        ctx.beginPath();
        ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
        ctx.fillStyle = entity.color;
        ctx.fill();

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(entity.x, entity.y, entity.radius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "#ffff44";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
        ctx.strokeStyle = isMyTeam ? "rgba(100,150,255,0.6)" : "rgba(255,100,100,0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();

        if (entity.health < entity.maxHealth) {
          const barWidth = entity.radius * 2;
          const barHeight = 4;
          const barX = entity.x - entity.radius;
          const barY = entity.y - entity.radius - 8;
          const healthPct = entity.health / entity.maxHealth;
          ctx.fillStyle = "#333";
          ctx.fillRect(barX, barY, barWidth, barHeight);
          ctx.fillStyle =
            healthPct > 0.5
              ? "#44cc44"
              : healthPct > 0.25
                ? "#cccc44"
                : "#cc4444";
          ctx.fillRect(barX, barY, barWidth * healthPct, barHeight);
        }

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label =
          entity.type === "crystal"
            ? "C"
            : entity.type === "worker"
              ? "W"
              : entity.type === "resource_node"
                ? "R"
                : "?";
        ctx.fillText(label, entity.x, entity.y);
      }
    }

    // Draw hover line for move command
    if (hoverPos && selectedEntityId) {
      const entity = entities.find((e) => e.id === selectedEntityId);
      if (entity) {
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

    // Draw build mode preview
    if (buildMode && selectedBuildingType && hoverPos && myCrystal) {
      ctx.beginPath();
      ctx.arc(hoverPos.x, hoverPos.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      const color = BUILDING_COLORS[selectedBuildingType];
      ctx.fillStyle = `${color}44`;
      ctx.fillRect(hoverPos.x - 22, hoverPos.y - 22, 44, 44);
    }

    // Draw match phase overlay
    if (matchState) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, width, 32);

      ctx.fillStyle = "#8888ff";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const phaseLabel =
        matchState.phase === "spawn"
          ? "SPAWNING"
          : matchState.phase === "playing"
            ? "IN GAME"
            : "ENDED";
      ctx.fillText(`[${phaseLabel}] Tick: ${matchState.tick}`, width / 2, 16);

      ctx.fillStyle = "#666";
      ctx.font = "11px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`Match: ${matchState.id.slice(0, 8)}`, width - 10, 16);
    }
  }, [matchState, player.id, selectedEntityId, hoverPos, myEntities, resourceNodes, buildMode, selectedBuildingType, myCrystal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

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
  const selectedEntity = myEntities.find((e) => e.id === selectedEntityId);
  const isBuildingSelected = selectedEntity?.type === "building";

  const canBuildSupplyDepot = myEconomy && myEconomy.resources >= 50;
  const canBuildBarracks = myEconomy && myEconomy.resources >= 75;
  const canBuildFoundry = myEconomy && myEconomy.resources >= 100;
  const canBuildTurret = myEconomy && myEconomy.resources >= 60;

  return (
    <div style={styles.container}>
      <div style={styles.gameArea}>
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          style={styles.canvas}
        />
      </div>

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
            {myEntities.length > 0 && selectedEntityId
              ? selectedEntity?.type === "crystal"
                ? "Crystal selected"
                : selectedEntity?.type === "building"
                  ? `${selectedEntity.buildingType || "Building"} selected`
                  : "Click unit to select, click ground to move, click node to gather"
              : "Click your units to select them"}
          </span>
          <span style={styles.infoText}>Tick: {matchState?.tick ?? 0}</span>
        </div>
      </div>

      <div style={styles.debugSection}>
        <p style={styles.debugTitle}>Debug Controls</p>
        <div style={styles.debugButtons}>
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
      </div>

      {isCrystalSelected && (
        <div style={styles.trainBar}>
          <button
            style={{
              ...styles.trainButton,
              ...(canTrain ? styles.trainButtonActive : styles.trainButtonDisabled),
            }}
            onClick={handleTrainWorker}
            disabled={!canTrain}
          >
            Train Worker (25⛏ + 1📦)
          </button>
          {!canTrain && myEconomy && (
            <span style={styles.trainHint}>
              {myEconomy.resources < 25
                ? `Need ${25 - myEconomy.resources} more resources`
                : `Need ${myEconomy.maxSupply - myEconomy.supply} more supply capacity`}
            </span>
          )}
          <button
            style={{
              ...styles.buildModeButton,
              ...(buildMode ? styles.buildModeButtonActive : {}),
            }}
            onClick={() => setBuildMode(!buildMode)}
          >
            {buildMode ? "Cancel Build" : "Build Structure"}
          </button>
        </div>
      )}

      {buildMode && selectedBuildingType && (
        <div style={styles.buildBar}>
          <span style={styles.buildLabel}>
            Building: {selectedBuildingType} ({BUILDING_LABELS[selectedBuildingType]})
          </span>
          <button
            style={styles.buildConfirmButton}
            onClick={() => {}}
          >
            Click on map to place
          </button>
          <button style={styles.buildCancelButton} onClick={handleCancelBuild}>
            Cancel
          </button>
        </div>
      )}

      {isBuildingSelected && !buildMode && (
        <div style={styles.buildBar}>
          <span style={styles.buildLabel}>
            {selectedEntity?.buildingType ? BUILDING_LABELS[selectedEntity.buildingType] : "Building"}
          </span>
          {selectedEntity?.productionQueue.length > 0 && (
            <span style={styles.buildLabel}>
              Producing: {selectedEntity.productionQueue[0].unitType} ({Math.ceil(selectedEntity.productionQueue[0].remainingTicks / 10)}s)
            </span>
          )}
          {selectedEntity?.buildingType && BUILDING_UNIT_MAP[selectedEntity.buildingType].length > 0 && (
            <button
              style={{
                ...styles.buildConfirmButton,
                ...(!showUnitQueue ? styles.buildConfirmButtonActive : {}),
              }}
              onClick={() => setShowUnitQueue(!showUnitQueue)}
            >
              Queue Unit
            </button>
          )}
          {showUnitQueue && selectedEntity?.buildingType && (
            <div style={styles.unitQueuePanel}>
              {BUILDING_UNIT_MAP[selectedEntity.buildingType].map((unitType) => {
                const unitCost = UNIT_COSTS[unitType];
                const canAfford = myEconomy && myEconomy.resources >= unitCost.cost && myEconomy.supply + unitCost.supplyCost <= myEconomy.maxSupply;
                return (
                  <button
                    key={unitType}
                    style={{
                      ...styles.unitQueueButton,
                      ...(canAfford ? styles.unitQueueButtonActive : styles.unitQueueButtonDisabled),
                    }}
                    onClick={() => {
                      onGameCommand({ type: "train_unit", entityId: selectedEntity.id, targetEntityId: unitType });
                      setShowUnitQueue(false);
                    }}
                    disabled={!canAfford}
                  >
                    {unitType} ({unitCost.cost}⛏ + {unitCost.supplyCost}📦)
                  </button>
                );
              })}
              <button style={styles.unitQueueCancelButton} onClick={() => setShowUnitQueue(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {buildMode && (
        <div style={styles.buildTypeBar}>
          <span style={styles.buildTypeLabel}>Select building:</span>
          <button
            style={{
              ...styles.buildTypeButton,
              ...(canBuildSupplyDepot ? {} : styles.buildTypeButtonDisabled),
            }}
            onClick={() => handleBuildClick("supply_depot")}
            disabled={!canBuildSupplyDepot}
          >
            Supply Depot (50⛏)
          </button>
          <button
            style={{
              ...styles.buildTypeButton,
              ...(canBuildBarracks ? {} : styles.buildTypeButtonDisabled),
            }}
            onClick={() => handleBuildClick("barracks")}
            disabled={!canBuildBarracks}
          >
            Barracks (75⛏)
          </button>
          <button
            style={{
              ...styles.buildTypeButton,
              ...(canBuildFoundry ? {} : styles.buildTypeButtonDisabled),
            }}
            onClick={() => handleBuildClick("foundry")}
            disabled={!canBuildFoundry}
          >
            Foundry (100⛏)
          </button>
          <button
            style={{
              ...styles.buildTypeButton,
              ...(canBuildTurret ? {} : styles.buildTypeButtonDisabled),
            }}
            onClick={() => handleBuildClick("turret")}
            disabled={!canBuildTurret}
          >
            Turret (60⛏)
          </button>
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
    background: "#0a0a1a",
    overflow: "hidden",
  },
  gameArea: {
    flex: 1,
    position: "relative" as const,
    overflow: "hidden",
  },
  canvas: {
    width: "100%",
    height: "100%",
    display: "block",
    cursor: "crosshair",
  },
  overlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
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
  debugSection: {
    padding: "8px 16px",
    background: "rgba(0,0,0,0.8)",
    borderTop: "1px solid rgba(100,100,200,0.15)",
  },
  debugTitle: {
    fontSize: "11px",
    color: "#666",
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
    marginBottom: "6px",
    textAlign: "center" as const,
  },
  debugButtons: {
    display: "flex",
    gap: "8px",
    justifyContent: "center",
  },
  debugButton: {
    padding: "6px 12px",
    fontSize: "12px",
    background: "rgba(100,100,100,0.2)",
    color: "#999",
    border: "1px solid rgba(100,100,100,0.3)",
    borderRadius: "4px",
    cursor: "pointer",
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
