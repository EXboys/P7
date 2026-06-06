import {
  countPlanStatesByStatuses,
  countPlanStatesWithDelivery,
  countPlanStatesWithPr,
  getGoalCostSum,
  listPlanStates,
  listPlanStatesWithDelivery,
  listPlanStatesWithPr,
  queryEvalRouteStats,
} from "./state.ts";
import type { PlanStateStatus } from "./types.ts";

export const stateQuery = {
  listRecentPlans: listPlanStates,
  countByStatuses: (projectPath: string, statuses: PlanStateStatus[]) =>
    countPlanStatesByStatuses(projectPath, statuses),
  listWithDelivery: listPlanStatesWithDelivery,
  listWithPr: listPlanStatesWithPr,
  countWithDelivery: countPlanStatesWithDelivery,
  countWithPr: countPlanStatesWithPr,
  getGoalCostSum,
  queryEvalRouteStats,
};
