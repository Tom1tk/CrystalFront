import { ECONOMY, GATHERING, MAP, ENTITY, SIMULATION, } from "@crystalfront/shared";
export const DEFAULT_CONFIG = {
    tickIntervalMs: SIMULATION.tickIntervalMs,
    mapWidth: MAP.width,
    mapHeight: MAP.height,
    crystalHealth: ENTITY.crystal.health,
    crystalRadius: ENTITY.crystal.radius,
    workerHealth: ENTITY.worker.health,
    workerRadius: ENTITY.worker.radius,
    placeholderHealth: ENTITY.placeholder.health,
    placeholderRadius: ENTITY.placeholder.radius,
    startingResources: ECONOMY.startingResources,
    startingMaxSupply: ECONOMY.startingMaxSupply,
    workerTrainCost: ECONOMY.workerTrainCost,
    workerSupplyCost: ECONOMY.workerSupplyCost,
    gatherRatePerTick: GATHERING.ratePerTick,
    viewportWidth: MAP.viewportWidth,
    viewportHeight: MAP.viewportHeight,
};
