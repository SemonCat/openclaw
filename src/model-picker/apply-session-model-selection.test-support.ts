import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ApplySessionModelSelectionParams } from "./apply-session-model-selection.js";

export const modelSelectionTestCatalog = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus",
    contextTokens: 32_000,
  },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextTokens: 16_000 },
] satisfies ModelCatalogEntry[];

export function createModelSelectionTestEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    delivery: { kind: "none" },
    ...overrides,
  };
}

export function createModelSelectionTestParams(
  overrides: Partial<ApplySessionModelSelectionParams> = {},
) {
  const sessionEntry = overrides.sessionEntry ?? createModelSelectionTestEntry();
  const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
  return {
    cfg: {},
    agentId: "main",
    sessionKey,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    currentProvider: "anthropic",
    currentModel: "claude-opus-4-6",
    modelCatalog: modelSelectionTestCatalog,
    thinkingCatalog: modelSelectionTestCatalog,
    canPersistStickyModelSelection: false,
    request: {
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
      runtime: { kind: "unchanged" },
    },
    markLiveSwitchPending: true,
    ...overrides,
  } satisfies ApplySessionModelSelectionParams;
}
