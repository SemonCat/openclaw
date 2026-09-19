import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./attempt-execution.helpers.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("returns original body on first attempt (isFallbackRetry=false)", () => {
    expect(resolveFallbackRetryPrompt({ body: originalBody, isFallbackRetry: false })).toBe(
      originalBody,
    );
  });

  it("prepends recovery prefix to original body on fallback retry with existing session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe(`[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`);
  });

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
    expect(result).toContain("do not claim completion while the plan has unfinished steps");
  });

  it("preserves original body for fallback retry when sessionHasHistory is undefined", () => {
    expect(resolveFallbackRetryPrompt({ body: originalBody, isFallbackRetry: true })).toBe(
      originalBody,
    );
  });

  it("returns original body on first attempt regardless of sessionHasHistory", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
      }),
    ).toBe(originalBody);
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: false,
      }),
    ).toBe(originalBody);
  });

  it("prepends priorContextPrelude before the retry marker on fallback retry", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: true,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("emits the retry prompt with prelude even when sessionHasHistory is false (claude-cli case)", () => {
    const prelude = "## Prior session context (from claude-cli)\nuser: prior question";
    const result = resolveFallbackRetryPrompt({
      body: originalBody,
      isFallbackRetry: true,
      sessionHasHistory: false,
      priorContextPrelude: prelude,
    });
    expect(result).toBe(
      `${prelude}\n\n[Retry after the previous model attempt failed or timed out]\n\n${originalBody}`,
    );
  });

  it("ignores empty/whitespace priorContextPrelude", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasHistory: false,
        priorContextPrelude: "   \n  ",
      }),
    ).toBe(originalBody);
  });

  it("does not prepend prelude on non-fallback first attempts", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasHistory: true,
        priorContextPrelude: "anything",
      }),
    ).toBe(originalBody);
  });
});
