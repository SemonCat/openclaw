import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async () => {}),
}));

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});

import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type ControllerInput = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];

function createController(advanceAuthProfile: ControllerInput["advanceAuthProfile"]) {
  return createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "run:failover-retry-controller-test",
    } as ControllerInput["runParams"],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    agentDir: "/tmp/openclaw-failover-retry-controller-test",
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => "openai:p1",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile,
  });
}

describe("createEmbeddedRunFailoverRetryController", () => {
  beforeEach(() => {
    mocks.sleepWithAbort.mockClear();
  });

  it("preserves the full same-model retry budget when rate-limit rotation does not advance", async () => {
    const advanceAuthProfile = vi.fn(async () => false);
    const controller = createController(advanceAuthProfile);

    await expect(controller.advanceRateLimitAuthProfile()).resolves.toBe(false);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(false);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(3);
  });

  it("consumes same-model retry eligibility after a successful rate-limit rotation", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile);

    await expect(controller.advanceRateLimitAuthProfile()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(false);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("does not spend rate-limit rotation eligibility on an ordinary profile advance", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile);

    await expect(controller.advanceAuthProfile()).resolves.toBe(true);
    await expect(controller.maybeRetrySameModelRateLimit()).resolves.toBe(true);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(mocks.sleepWithAbort).toHaveBeenCalledWith(10_000, undefined);
  });

  it("keeps rotating until every configured profile is exhausted", async () => {
    const remainingProfiles = [true, true, true, true, false];
    const advanceAuthProfile = vi.fn(async () => remainingProfiles.shift() ?? false);
    const controller = createController(advanceAuthProfile);

    for (let index = 0; index < 4; index += 1) {
      await expect(controller.advanceRateLimitAuthProfile()).resolves.toBe(true);
    }
    await expect(controller.advanceRateLimitAuthProfile()).resolves.toBe(false);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(5);
  });
});
