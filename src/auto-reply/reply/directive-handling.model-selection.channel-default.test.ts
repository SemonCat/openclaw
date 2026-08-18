import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const aliasIndex = {
  byAlias: new Map([
    ["openai-sol", { alias: "openai-sol", ref: { provider: "openai", model: "gpt-5.5" } }],
  ]),
  byKey: new Map([["openai/gpt-5.5", ["openai-sol"]]]),
};

function resolve(command: string) {
  return resolveModelSelectionFromDirective({
    directives: parseInlineSessionDirectives(command, { modelAliases: ["openai-sol"] }),
    cfg: { commands: { text: true } } as OpenClawConfig,
    agentDir: "/tmp/agent",
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    sessionDefaultProvider: "sub2api-op-go",
    sessionDefaultModel: "deepseek-v4-flash",
    aliasIndex,
    allowedModelKeys: new Set(["openai/gpt-5.5", "sub2api-op-go/deepseek-v4-flash"]),
    allowedModelCatalog: [],
    provider: "sub2api-op-go",
  });
}

describe("model selection with a channel default", () => {
  it("keeps an explicit agent-default selection as a session override", () => {
    expect(resolve("/model openai-sol").modelSelection).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      alias: "openai-sol",
      isDefault: false,
    });
  });

  it("resets /model default to the effective channel default", () => {
    expect(resolve("/model default").modelSelection).toEqual({
      provider: "sub2api-op-go",
      model: "deepseek-v4-flash",
      isDefault: true,
    });
  });
});
