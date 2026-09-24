import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGatewayProbeSnapshot: vi.fn(),
}));

vi.mock("./status.scan.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.scan.shared.js")>()),
  resolveGatewayProbeSnapshot: mocks.resolveGatewayProbeSnapshot,
}));

import { createStatusScanCoreBootstrap } from "./status.scan.bootstrap-shared.js";

describe("createStatusScanCoreBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finishes the gateway probe before starting synchronous agent inspection", async () => {
    let resolveProbe!: (value: { gatewayReachable: boolean }) => void;
    const probePromise = new Promise<{ gatewayReachable: boolean }>((resolve) => {
      resolveProbe = resolve;
    });
    mocks.resolveGatewayProbeSnapshot.mockReturnValue(probePromise);
    const getAgentLocalStatuses = vi.fn(async () => ({ defaultId: "main" }));

    const bootstrap = await createStatusScanCoreBootstrap({
      coldStart: false,
      cfg: {},
      configPath: "/tmp/openclaw.json",
      env: {},
      hasConfiguredChannels: true,
      opts: {},
      skipUpdateCheck: true,
      getTailnetHostname: vi.fn(async () => null),
      getUpdateCheckResult: vi.fn(),
      getAgentLocalStatuses,
    });

    expect(getAgentLocalStatuses).not.toHaveBeenCalled();
    resolveProbe({ gatewayReachable: true });
    await bootstrap.gatewayProbePromise;
    await bootstrap.agentStatusPromise;

    expect(getAgentLocalStatuses).toHaveBeenCalledOnce();
  });
});
