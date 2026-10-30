import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronTool } from "./cron-tool.js";

const pending = { entries: [], total: 0, offset: 0, limit: 1, hasMore: false, nextOffset: null };
const finished = {
  ...pending,
  entries: [
    {
      ts: 1,
      jobId: "target",
      runId: "manual:target:1",
      action: "finished",
      status: "ok",
      deliveryStatus: "not-requested",
    },
  ],
  total: 1,
};
afterEach(() => vi.useRealTimers());

describe("automation exact-run follow-up", () => {
  it.each([
    { name: "empty history", initial: pending },
    {
      name: "another completed run",
      initial: { ...finished, entries: [{ ...finished.entries[0], runId: "another-run" }] },
    },
  ])("keeps waiting past $name and returns the requested run", async ({ initial }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const call = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(finished);
    const tool = createCronTool(undefined, { callGatewayTool: call });
    const result = tool.execute("wait", {
      action: "runs",
      jobId: "target",
      runId: "manual:target:1",
      waitSeconds: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(call.mock.calls[0]?.[2]).toEqual({ id: "target", runId: "manual:target:1", limit: 1 });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const reply = await result;
    expect(reply.details).toEqual(finished);
    expect(
      Value.Check(expectDefined(tool.outputSchema, "automation output schema"), reply.details),
    ).toBe(true);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["cron.runs", "cron.runs"]);
    expect(call.mock.calls[1]?.[1].timeoutMs).toBeLessThanOrEqual(8000);
  });

  it("stops waiting at its deadline without enqueueing another run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const call = vi.fn().mockResolvedValue(pending);
    const tool = createCronTool(undefined, { callGatewayTool: call });
    const result = tool.execute("wait", {
      action: "runs",
      jobId: "target",
      runId: "manual:target:1",
      waitSeconds: 1,
    });
    await Promise.all([
      expect(result).rejects.toThrow(/timed out waiting.*not cancelled/i),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[0]).toBe("cron.runs");
  });

  it("does not continue polling after cancellation or a scope denial", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const controller = new AbortController();
    const call = vi.fn().mockResolvedValue(pending);
    const tool = createCronTool(undefined, { callGatewayTool: call });
    const result = tool.execute(
      "wait",
      { action: "runs", jobId: "target", runId: "manual:target:1", waitSeconds: 10 },
      controller.signal,
    );
    await Promise.all([
      expect(result).rejects.toThrow(/aborted/i),
      (async () => {
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
      })(),
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(call).toHaveBeenCalledOnce();

    call
      .mockReset()
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error("owner authority revoked"));
    await Promise.all([
      expect(
        tool.execute("denied", {
          action: "runs",
          jobId: "target",
          runId: "manual:target:1",
          waitSeconds: 10,
        }),
      ).rejects.toThrow("owner authority revoked"),
      vi.advanceTimersByTimeAsync(2000),
    ]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([
    { waitSeconds: 1 },
    { action: "run", waitSeconds: 1 },
    { runId: "manual:target:1", waitSeconds: -1 },
    { runId: "manual:target:1", waitSeconds: 61 },
    { runId: "manual:target:1", waitSeconds: 0.5 },
  ])("rejects invalid waiting input before RPC: %j", async (input) => {
    const call = vi.fn();
    const tool = createCronTool(undefined, { callGatewayTool: call });
    await expect(
      tool.execute("invalid", { action: "runs", jobId: "target", ...input }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("does not grant a scheduled watcher access to another automation", async () => {
    const call = vi.fn();
    const tool = createCronTool({ selfRemoveOnlyJobId: "watcher" }, { callGatewayTool: call });
    await expect(
      tool.execute("denied", {
        action: "runs",
        jobId: "target",
        runId: "manual:target:1",
        waitSeconds: 10,
      }),
    ).rejects.toThrow("restricted to the current automation");
    expect(call).not.toHaveBeenCalled();
  });
});
