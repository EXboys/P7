import { updateJobStepState } from "../job-step-state.ts";
import type { StepState } from "../job-types.ts";
export type { StepState } from "../job-types.ts";

export interface StepReporter {
  record(step: StepState): void;
  failRunning(error: string): void;
}

export function createNoopStepReporter(): StepReporter {
  return { record: () => {}, failRunning: () => {} };
}

export function createJobStepReporter(jobId: string | undefined): StepReporter {
  if (!jobId) return createNoopStepReporter();
  const stepStartTimes = new Map<string, string>();
  return {
    record(step) {
      if (step.status === "running") {
        stepStartTimes.set(step.step_name, step.started_at);
      } else if (!step.started_at) {
        step.started_at = stepStartTimes.get(step.step_name) ?? "";
      }
      updateJobStepState(jobId, step).catch(() => {});
    },
    failRunning(error) {
      const now = new Date().toISOString();
      for (const [stepName, startedAt] of stepStartTimes) {
        this.record({
          step_name: stepName,
          status: "failed",
          started_at: startedAt,
          finished_at: now,
          error: error.slice(0, 500),
        });
      }
    },
  };
}
