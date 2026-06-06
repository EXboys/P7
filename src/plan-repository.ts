import {
  getPlanState,
  listPlanStates,
  listPlanStatesByStatuses,
  preparePlanExecuteRetry,
  transitionPlanState,
  upsertPlanState,
} from "./state.ts";
import type { PlanState, PlanStateStatus } from "./types.ts";

export interface PlanRepository {
  get(projectPath: string, planId: string): PlanState | null;
  list(projectPath: string, limit?: number, offset?: number): PlanState[];
  listByStatus(
    projectPath: string,
    statuses: PlanStateStatus[],
    limit?: number,
    offset?: number,
  ): PlanState[];
  upsert: typeof upsertPlanState;
  transition: typeof transitionPlanState;
  prepareExecuteRetry: typeof preparePlanExecuteRetry;
}

export const planRepository: PlanRepository = {
  get: getPlanState,
  list: listPlanStates,
  listByStatus: listPlanStatesByStatuses,
  upsert: upsertPlanState,
  transition: transitionPlanState,
  prepareExecuteRetry: preparePlanExecuteRetry,
};
