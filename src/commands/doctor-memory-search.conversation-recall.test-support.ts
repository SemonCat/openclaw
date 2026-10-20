import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

type ConversationRecallDoctorTestParams = {
  note: Mock;
  firstNoteMessage: () => string;
  runConversationRecallHealth: (
    plugins?: OpenClawConfig["plugins"],
    rememberAcrossConversations?: boolean,
    overrides?: Record<string, unknown>,
  ) => Promise<void>;
};

const recallEnabled =
  'Remember across conversations is effectively enabled for agent "personal", but';
const activeMemoryDisabled = `${recallEnabled} the Active Memory plugin is disabled. Enable the plugin or set memory.search.rememberAcrossConversations to false.`;

/** Registers remember-across-conversations health coverage against the shared Doctor mocks. */
export function registerConversationRecallDoctorTests(
  params: ConversationRecallDoctorTestParams,
): void {
  it("does not warn about conversation recall when the setting is off", async () => {
    await params.runConversationRecallHealth(undefined, false, {});

    expect(params.note).not.toHaveBeenCalled();
  });

  it("does not treat Lossless Claw's context-engine slot as a memory-slot conflict", async () => {
    await params.runConversationRecallHealth({
      slots: { contextEngine: "lossless-claw" },
      entries: {
        "active-memory": { enabled: true },
        "lossless-claw": { enabled: true },
      },
    });

    expect(params.note).not.toHaveBeenCalled();
  });

  it.each<{ name: string; plugins: OpenClawConfig["plugins"]; expected: string }>([
    {
      name: "the custom-memory provider lacks protected transcript recall",
      plugins: {
        slots: { memory: "custom-memory" },
        entries: { "active-memory": { enabled: true, config: { toolsAllow: ["memory_search"] } } },
      },
      expected: `${recallEnabled} the current memory provider does not support protected private transcript recall. Set memory.search.rememberAcrossConversations to false or use that provider's own recall path; advanced Active Memory can still use its recall tools.`,
    },
    {
      name: "Active Memory is disabled",
      plugins: { entries: { "active-memory": { enabled: false } } },
      expected: activeMemoryDisabled,
    },
    {
      name: "Active Memory is paused in plugin config",
      plugins: { entries: { "active-memory": { enabled: true, config: { enabled: false } } } },
      expected: activeMemoryDisabled,
    },
    {
      name: "Active Memory excludes memory_search",
      plugins: {
        entries: { "active-memory": { enabled: true, config: { toolsAllow: ["memory_get"] } } },
      },
      expected: `${recallEnabled} Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memory.search.rememberAcrossConversations to false.`,
    },
  ])("warns when conversation recall is enabled but $name", async ({ plugins, expected }) => {
    await params.runConversationRecallHealth(plugins);

    expect(params.firstNoteMessage()).toBe(expected);
  });
}
