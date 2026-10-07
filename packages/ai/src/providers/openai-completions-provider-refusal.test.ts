import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const model = {
  id: "test-model",
  name: "Compatible provider",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;
let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});
afterEach(() => {
  configureAiTransportHost(previousHost);
});

const cases = (["http", "sse", "partial-sse"] as const).flatMap((shape) =>
  ["cyber_policy", "invalid_prompt"].map((code) => ({ shape, code })),
);

describe.each([
  { name: "package", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
])("$name OpenAI-compatible provider refusals", ({ createStream }) => {
  it.each(cases)(
    "handles $code on $shape without losing partial output",
    async ({ shape, code }) => {
      const error = {
        code,
        type: "invalid_request_error",
        message: "The provider declined this request.",
      };
      const fetchMock = vi.fn<typeof fetch>(async () => {
        if (shape === "http") {
          return new Response(JSON.stringify({ error }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const partial = {
          id: "chatcmpl-partial",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [{ index: 0, delta: { content: "Visible progress." }, finish_reason: null }],
        };
        return new Response(
          `${shape === "partial-sse" ? `data: ${JSON.stringify(partial)}\n\n` : ""}data: ${JSON.stringify({ error })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      configureAiTransportHost({ buildModelFetch: () => fetchMock });

      const stream = await createStream(model, context, { apiKey: "test" });
      const result = await stream.result();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        provider: model.provider,
        stopReason: "error",
        errorCode: code,
        errorType: error.type,
      });
      expect(result.errorMessage).toContain(error.message);
      expect(result.content).toEqual(
        shape === "partial-sse"
          ? [expect.objectContaining({ type: "text", text: "Visible progress." })]
          : [],
      );
      if (code === "cyber_policy") {
        expect(result.diagnostics).toEqual([
          {
            type: "provider_refusal",
            timestamp: expect.any(Number),
            details: { provider: model.provider, category: "cyber" },
          },
        ]);
      } else {
        expect(result.diagnostics?.some((entry) => entry.type === "provider_refusal")).not.toBe(
          true,
        );
      }
    },
  );
});
