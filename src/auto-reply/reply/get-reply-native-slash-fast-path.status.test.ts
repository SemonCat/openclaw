import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

type NativeStatusSelectionCase = {
  selection: string;
  source: "user" | "auto" | undefined;
  channelModel?: string;
  deliveryChannel?: string;
  directSenderId?: string;
  directUserId?: string;
  expectedModel?: string;
  expectedProvider?: string;
  groupId?: string;
  locked?: boolean;
  modelParentSessionKey?: string;
  preparedModel?: string;
  preparedProvider?: string;
};

const { buildStatusReplyMock, handleCommandsMock } = vi.hoisted(() => ({
  buildStatusReplyMock: vi.fn(),
  handleCommandsMock: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("native slash channel model routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT",
        provider: "openai",
        contextWindow: 400_000,
        reasoning: false,
      },
      {
        id: "claude-fable-5",
        name: "Fable",
        provider: "anthropic",
        contextWindow: 1_000_000,
        reasoning: true,
      },
    ]);
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue({
      entries: [
        {
          id: "gpt-5.5",
          name: "GPT",
          provider: "openai",
          contextWindow: 400_000,
          reasoning: false,
        },
        {
          id: "claude-fable-5",
          name: "Fable",
          provider: "anthropic",
          contextWindow: 1_000_000,
          reasoning: true,
        },
      ],
      routeVariants: [],
    });
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
    handleCommandsMock.mockReset();
    handleCommandsMock.mockResolvedValue({ shouldContinue: true, reply: undefined });
  });

  it("pins the agent default and resets to the channel default through native /model", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-channel-model-"), "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "channel-model-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
        groupId: "123",
        chatType: "group",
      },
    );
    const cfg = markCompleteReplyConfig({
      session: { store: storePath },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": {},
            "anthropic/claude-fable-5": {},
          },
        },
      },
      channels: {
        modelByChannel: { telegram: { "123": "anthropic/claude-fable-5" } },
      },
    } as OpenClawConfig);
    const runModelCommand = (body: string) =>
      maybeResolveNativeSlashCommandFastReply({
        ctx: buildTestCtx({
          Body: body,
          BodyForAgent: body,
          RawBody: body,
          CommandBody: body,
          CommandSource: "native",
          CommandAuthorized: true,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: sessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "model",
            body,
          },
        }),
        cfg,
        agentId: "main",
        agentDir: "/tmp/agent",
        agentCfg: cfg.agents?.defaults,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        aliasIndex: { byKey: new Map(), byAlias: new Map() },
        provider: "openai",
        model: "gpt-5.5",
        workspaceDir: "/tmp/workspace",
        typing: createTypingController(),
      });

    const pinned = await runModelCommand("/model openai/gpt-5.5");

    expect(pinned).toMatchObject({
      handled: true,
      reply: {
        text: "Model set to openai/gpt-5.5 for this session only; configured default unchanged.",
      },
    });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });

    const reset = await runModelCommand("/model default");

    expect(reset).toMatchObject({
      handled: true,
      reply: {
        text: "Session model reset to configured default (anthropic/claude-fable-5).",
      },
    });
    const resetEntry = loadExactSessionEntry({ sessionKey, storePath })?.entry;
    expect(resetEntry?.providerOverride).toBeUndefined();
    expect(resetEntry?.modelOverride).toBeUndefined();
    expect(resetEntry?.modelOverrideSource).toBeUndefined();
  });

  const statusSelectionCases: NativeStatusSelectionCase[] = [
    { selection: "user override", source: "user" },
    { selection: "automatic fallback", source: "auto" },
    {
      selection: "channel override",
      source: undefined,
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "configured channel model alias",
      source: undefined,
      channelModel: "Fable",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current command channel over stale session delivery",
      source: undefined,
      deliveryChannel: "discord",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "parent group override for a topic",
      source: undefined,
      groupId: "123:topic:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "thread-only model parent session override",
      source: undefined,
      groupId: "unmatched-thread",
      modelParentSessionKey: "agent:main:telegram:group:123:thread:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "native direct peer override before wildcard",
      source: undefined,
      directUserId: "native-peer-42",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender override before wildcard",
      source: undefined,
      directSenderId: "live-peer-43",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender over another channel's persisted peer",
      source: undefined,
      deliveryChannel: "discord",
      directUserId: "stale-discord-peer",
      directSenderId: "live-telegram-peer",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "locked model selection",
      source: undefined,
      locked: true,
    },
    {
      selection: "prepared non-default heartbeat or fallback model",
      source: undefined,
      preparedProvider: "xai",
      preparedModel: "grok-4.3",
      expectedProvider: "xai",
      expectedModel: "grok-4.3",
    },
  ];

  it.each(statusSelectionCases)(
    "preserves canonical native /status $selection",
    async (testCase) => {
      const targetSessionKey = "agent:main:main";
      const storePath = path.join(tempDirs.make("openclaw-native-status-"), "sessions.json");
      const {
        channelModel = "anthropic/claude-fable-5",
        deliveryChannel = "telegram",
        directSenderId,
        directUserId,
        expectedModel = "gpt-5.5",
        expectedProvider = "openai",
        groupId = "123",
        locked = false,
        modelParentSessionKey,
        preparedModel = "gpt-5.5",
        preparedProvider = "openai",
        source,
      } = testCase;
      const isDirect = directUserId !== undefined || directSenderId !== undefined;
      const overrideKey = directSenderId ?? directUserId ?? "123";
      const conflictingDirectUserId =
        directSenderId !== undefined && directUserId !== undefined ? directUserId : undefined;
      await replaceSessionEntry(
        { agentId: "main", sessionKey: targetSessionKey, storePath },
        {
          sessionId: "status-session",
          updatedAt: Date.now(),
          contextTokens: 1_000_000,
          delivery: normalizeSessionDeliveryState({
            context: { channel: deliveryChannel },
            ...(directUserId
              ? { origin: { provider: deliveryChannel, nativeDirectUserId: directUserId } }
              : {}),
          }),
          ...(isDirect ? {} : { groupId }),
          ...(locked ? { modelSelectionLocked: true } : {}),
          ...(source
            ? {
                providerOverride: "anthropic",
                modelOverride: "claude-fable-5",
                modelOverrideSource: source,
                ...(source === "auto"
                  ? {
                      modelOverrideFallbackOriginProvider: "openai",
                      modelOverrideFallbackOriginModel: "gpt-5.5",
                      modelProvider: "openai",
                      model: "gpt-5.5",
                    }
                  : {}),
              }
            : {}),
        },
      );

      const result = await maybeResolveNativeSlashCommandFastReply({
        ctx: buildTestCtx({
          Body: "/status",
          CommandBody: "/status",
          CommandSource: "native",
          CommandAuthorized: true,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: isDirect ? "direct" : "group",
          ...(directSenderId
            ? { From: `telegram:${directSenderId}`, SenderId: directSenderId }
            : {}),
          ...(modelParentSessionKey ? { ModelParentSessionKey: modelParentSessionKey } : {}),
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "status",
            body: "/status",
          },
        }),
        cfg: markCompleteReplyConfig({
          session: { store: storePath },
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              modelPolicy: { allow: ["openai/*", "anthropic/*", "xai/*"] },
              models: {
                "anthropic/claude-fable-5": {
                  alias: "Fable",
                  params: { thinking: "high", fastMode: true },
                },
              },
            },
          },
          channels: {
            modelByChannel: {
              telegram: {
                [overrideKey]: channelModel,
                ...(conflictingDirectUserId ? { [conflictingDirectUserId]: "xai/grok-4.3" } : {}),
                "*": "openai/gpt-5.5",
              },
              discord: { "123": "openai/gpt-5.5" },
            },
          },
        } as OpenClawConfig),
        agentId: "main",
        agentDir: "/tmp/agent",
        agentCfg: undefined,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        aliasIndex: {
          byKey: new Map(),
          byAlias: new Map([
            ["fable", { alias: "Fable", ref: { provider: "anthropic", model: "claude-fable-5" } }],
          ]),
        },
        provider: preparedProvider,
        model: preparedModel,
        workspaceDir: "/tmp/workspace",
        typing: createTypingController(),
      });

      const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
      expect(statusCall).toMatchObject({ provider: expectedProvider, model: expectedModel });
      expect(statusCall.thinkingCatalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "anthropic",
            id: "claude-fable-5",
            contextWindow: 1_000_000,
          }),
        ]),
      );
      if (expectedProvider === "anthropic") {
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("high");
      }
      if (source) {
        expect(statusCall.sessionEntry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-fable-5",
          modelOverrideSource: source,
        });
      } else {
        expect(statusCall.sessionEntry).not.toHaveProperty("providerOverride");
        expect(statusCall.sessionEntry).not.toHaveProperty("modelOverride");
      }
      expect(result).toMatchObject({ reply: { text: "selected model status" } });
    },
  );
});
