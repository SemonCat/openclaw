import { describe, expect, it } from "vitest";
import {
  rebaseExecApprovalContinuationPromptRange,
  resolveFallbackRetryPrompt,
} from "./attempt-execution.helpers.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("continues from settled transcript state with the original objective but without replaying work", () => {
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: true,
      continueFromSettledTranscript: true,
    });

    expect(result).toContain("Continue from the current transcript after the latest tool result.");
    expect(result).toContain("do not rerun completed tools");
    expect(result).toContain("Original user request");
    expect(result).toContain(originalBody);
    const range = { start: 0, end: originalBody.length };
    const rebased = rebaseExecApprovalContinuationPromptRange({
      body: originalBody,
      prompt: result,
      range,
    });
    expect(result.slice(rebased?.start, rebased?.end)).toBe(originalBody);
    expect(result).toContain("do not claim completion while the plan has unfinished steps");
  });
});
