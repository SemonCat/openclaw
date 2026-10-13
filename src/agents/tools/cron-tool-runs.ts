import { waitForCronRunCompletion } from "../../cron/run-completion-wait.js";
import type { projectCronRunHistoryPage } from "../../cron/run-history.js";
import { readNonNegativeIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import type { callGatewayTool, GatewayCallOptions } from "./gateway.js";

type HistoryPage = ReturnType<typeof projectCronRunHistoryPage>;

/** Keep exact-run observation in the requesting tool's existing authorization scope. */
export async function readCronToolRunHistory(options: {
  id: string;
  params: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  callGateway: typeof callGatewayTool;
  signal?: AbortSignal;
}): Promise<HistoryPage> {
  const runId = readToolStringParam(options.params, "runId");
  const waitSeconds =
    readNonNegativeIntegerParam(options.params, "waitSeconds", {
      max: 60,
      message: "waitSeconds must be an integer from 0 to 60",
    }) ?? 0;
  if (waitSeconds > 0 && !runId) {
    throw new ToolInputError("runId is required when waiting for an automation run");
  }
  const readPage = (timeoutMs: number) =>
    options.callGateway<HistoryPage>(
      "cron.runs",
      {
        ...options.gatewayOpts,
        timeoutMs: Math.min(options.gatewayOpts.timeoutMs ?? 60_000, timeoutMs),
      },
      { id: options.id, ...(runId ? { runId, limit: 1 } : {}) },
      { signal: options.signal },
    );
  if (!runId || waitSeconds === 0) {
    return await readPage(options.gatewayOpts.timeoutMs ?? 60_000);
  }
  const { page } = await waitForCronRunCompletion({
    runId,
    timeoutMs: waitSeconds * 1_000,
    pollIntervalMs: 2_000,
    readPage,
    signal: options.signal,
  });
  return page;
}
