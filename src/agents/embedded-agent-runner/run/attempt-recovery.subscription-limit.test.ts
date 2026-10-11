import { describe, expect, it, vi } from "vitest";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

describe("subscription-limit recovery from settled tools", () => {
  it("rotates profiles and continues from settled tools after a subscription limit", async () => {
    const promptError = Object.assign(new Error("Codex subscription usage limit reached"), {
      status: 429,
    });
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop({
      promptError,
      rateLimitRotationResult: true,
      retryAvailable: false,
    });

    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(failoverRetryController.advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledTimes(1);
  });

  it("rotates after late synthetic failures from earlier settled tool batches", async () => {
    const promptError = Object.assign(
      new Error(
        "You've reached your Codex subscription usage limit. Next reset in 4 hours, Sep 8 at 7:59 PM GMT+8.",
      ),
      { status: 429 },
    );
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop({
      promptError,
      rateLimitRotationResult: true,
      lateSyntheticPriorFailures: true,
      latestToolResult: "success",
    });

    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(failoverRetryController.advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledWith({
      includeToolFailureInstruction: true,
    });
  });

  it.each(["missing", "absent"] as const)(
    "keeps rotation closed when the latest tool result is %s",
    async (latestToolResult) => {
      const promptError = Object.assign(new Error("Codex subscription usage limit reached"), {
        status: 429,
      });
      const { recovery, failoverRetryController } = await recoverAfterTransportDrop({
        promptError,
        rateLimitRotationResult: true,
        lateSyntheticPriorFailures: true,
        latestToolResult,
      });

      expect(recovery).toEqual({ action: "proceed" });
      expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    },
  );

  it("rotates after the terminal turn settles its latest accepted native command", async () => {
    const promptError = Object.assign(
      new Error(
        "You've reached your Codex subscription usage limit. Next reset in 5 hours, Sep 9 at 8:57 PM GMT+8.",
      ),
      { status: 429 },
    );
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop({
      promptError,
      rateLimitRotationResult: true,
      terminalizedLatestMissingResult: true,
    });

    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(failoverRetryController.advanceRateLimitAuthProfile).toHaveBeenCalledTimes(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledWith({
      includeToolFailureInstruction: true,
    });
  });

  it.each([
    [
      "the owner evidence names an unaccepted call",
      { terminalizedToolCalls: [{ toolCallId: "exec-unaccepted", toolName: "bash" }] },
    ],
    ["the terminal placeholder has an unrelated reason", { terminalizedResultReason: "unknown" }],
    ["another lifecycle item remains active", { activeCount: 2, startedCount: 3 }],
  ] as const)("keeps subscription-limit rotation closed when %s", async (_label, evidence) => {
    const promptError = Object.assign(new Error("Codex subscription usage limit reached"), {
      status: 429,
    });
    const { recovery, failoverRetryController, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({
        ...evidence,
        promptError,
        rateLimitRotationResult: true,
        terminalizedLatestMissingResult: true,
      });

    expect(recovery).toEqual({ action: "proceed" });
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ["a tool is still active", { activeCount: 1 }],
    ["the attempt already yielded", { yieldDetected: true }],
  ])("keeps subscription-limit rotation closed when %s", async (_label, scenario) => {
    const promptError = Object.assign(new Error("Codex subscription usage limit reached"), {
      status: 429,
    });
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop({
      ...scenario,
      promptError,
      rateLimitRotationResult: true,
      retryAvailable: false,
    });

    expect(recovery).toEqual({ action: "proceed" });
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it("arms transcript continuation before model fallback after profiles are exhausted", async () => {
    const promptError = Object.assign(new Error("Codex subscription usage limit reached"), {
      status: 429,
    });
    const onSettledTranscriptModelFallback = vi.fn();

    await expect(
      recoverAfterTransportDrop({
        promptError,
        rateLimitRotationResult: false,
        retryAvailable: false,
        onSettledTranscriptModelFallback,
        fallbackConfigured: true,
      }),
    ).rejects.toMatchObject({ reason: "rate_limit", status: 429 });
    expect(onSettledTranscriptModelFallback).toHaveBeenCalledTimes(1);
  });
});
