import { sleep } from "../utils/sleep.js";
import type { CronRunLogEntry } from "./run-log-types.js";

export class CronRunWaitTimeoutError extends Error {
  constructor(runId: string) {
    super(
      `timed out waiting for cron run ${runId}; the run was not cancelled. Check the same runId again.`,
    );
    this.name = "CronRunWaitTimeoutError";
  }
}

/** Observe one admitted run through history; never enqueue or cancel work while waiting. */
export async function waitForCronRunCompletion<
  Page extends { entries?: CronRunLogEntry[] },
>(params: {
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  readPage: (timeoutMs: number) => Promise<Page>;
  signal?: AbortSignal;
}): Promise<{ entry: CronRunLogEntry; page: Page }> {
  const startedAt = performance.now();
  let hasPolled = false;
  for (;;) {
    params.signal?.throwIfAborted();
    const elapsedBeforePollMs = Math.floor(performance.now() - startedAt);
    if (hasPolled && elapsedBeforePollMs >= params.timeoutMs) {
      throw new CronRunWaitTimeoutError(params.runId);
    }
    hasPolled = true;
    // A zero-duration CLI wait retains one immediate read. Each RPC shares the deadline.
    const page = await params.readPage(Math.max(1, params.timeoutMs - elapsedBeforePollMs));
    params.signal?.throwIfAborted();
    const entry = page.entries?.find(
      (candidate) =>
        // Older history responses can omit runId; the RPC itself is filtered to the requested run.
        (candidate.runId === undefined || candidate.runId === params.runId) &&
        (candidate.status === "ok" ||
          candidate.status === "error" ||
          candidate.status === "skipped"),
    );
    if (entry) {
      return { entry, page };
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    if (elapsedMs >= params.timeoutMs) {
      throw new CronRunWaitTimeoutError(params.runId);
    }
    await sleep(Math.min(params.pollIntervalMs, params.timeoutMs - elapsedMs), params.signal);
  }
}
