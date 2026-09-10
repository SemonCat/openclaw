import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

async function inspectKitchenSink(diagnosticSource?: "list" | "inspect") {
  const scenario = readQaScenarioById("kitchen-sink-live-openai");
  const config = scenario.execution.config as {
    pluginId: string;
    channelId: string;
    expectedProviderAny: string[];
    expectedToolAny: string[];
    expectedSurfaceIds: Record<string, string[]>;
  };
  const diagnostics = [
    { level: "error", message: "memory prompt preparation registration missing prepare function" },
  ];
  const inspect = {
    plugin: {
      id: config.pluginId,
      enabled: true,
      status: "loaded",
      channelIds: [config.channelId],
      providerIds: config.expectedProviderAny,
      contracts: { tools: config.expectedToolAny },
      ...config.expectedSurfaceIds,
      hookCount: 30,
    },
    commands: ["kitchen"],
    services: ["kitchen-sink-service"],
    typedHooks: Array.from({ length: 30 }, (_, index) => `hook-${index}`),
    diagnostics: diagnosticSource === "inspect" ? diagnostics : [],
  };
  const step = scenario.execution.flow?.steps[0];
  if (!step) {
    throw new Error("Kitchen Sink installation flow is missing");
  }
  return await runLoadedScenarioFlow(scenario.id, {
    flow: { steps: [step] },
    api: {
      env: { gateway: { configPath: "/qa/openclaw.json" } },
      fs: { readFile: async () => "{}", writeFile: async () => undefined },
      runQaCli: async (_env: unknown, args: string[]) => {
        switch (args[1]) {
          case "install":
          case "enable":
            return undefined;
          case "list":
            return { diagnostics: diagnosticSource === "list" ? diagnostics : [] };
          case "inspect":
            return inspect;
          default:
            throw new Error(`unexpected Kitchen Sink command: ${args.join(" ")}`);
        }
      },
    },
  });
}

describe("Kitchen Sink conformance evidence", () => {
  it("accepts an inspection with all surfaces and no registration errors", async () => {
    await expect(inspectKitchenSink()).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["list", "inspect"] as const)(
    "rejects adversarial-only registration errors in conformance %s output",
    async (source) => {
      await expect(inspectKitchenSink(source)).rejects.toThrow(
        "Kitchen Sink conformance personality emitted unexpected diagnostics",
      );
    },
  );
});
