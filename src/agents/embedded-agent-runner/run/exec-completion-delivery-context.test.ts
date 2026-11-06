import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { dropReasoningFromHistory } from "../thinking.js";
import {
  projectUndeliveredExecCompletion,
  type UndeliveredExecCompletion,
} from "./exec-completion-delivery-context.js";

const assistant = {
  ...buildEmbeddedRunnerAssistant({
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "The requested check passed." },
    ],
  }),
  timestamp: 12,
  responseId: "private-final",
  turnId: "completion-turn",
};
const completion: UndeliveredExecCompletion = {
  timestamp: assistant.timestamp,
  responseId: assistant.responseId,
  turnId: assistant.turnId,
  visibleText: "The requested check passed.",
};

describe("undelivered exec completion provider context", () => {
  it("recognizes the same final after the real history sanitizer removes thinking", () => {
    const sanitized = dropReasoningFromHistory([assistant]);
    expect(sanitized[0]).not.toBe(assistant);
    expect(projectUndeliveredExecCompletion(sanitized, completion)[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining(
        JSON.stringify({ undeliveredResult: completion.visibleText }),
      ),
    });
  });
  it("projects only the captured final and retains canonical history and later delivery calls", () => {
    const older = { ...assistant, timestamp: 1, responseId: "older-answer" };
    const prefix: AgentMessage[] = [
      { role: "user", content: "Run the check.", timestamp: 0 },
      older,
    ];
    const delivery = buildEmbeddedRunnerAssistant({
      content: [{ type: "toolCall", id: "send", name: "message", arguments: { action: "send" } }],
    });
    const messages: AgentMessage[] = [...prefix, assistant, delivery];
    const original = JSON.stringify(messages);
    const projected = projectUndeliveredExecCompletion(messages, completion);
    expect(projected.slice(0, 2)).toEqual(prefix);
    expect(projected[0]).toBe(prefix[0]);
    expect(projected[1]).toBe(older);
    expect(projected[2]).toMatchObject({
      role: "user",
      timestamp: 12,
      content: expect.stringContaining(
        JSON.stringify({ undeliveredResult: completion.visibleText }),
      ),
    });
    expect(JSON.stringify(projected[2])).not.toContain("private reasoning");
    expect(projected[3]).toBe(delivery);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it.each([
    { name: "no recovery", fact: undefined, messages: [assistant] },
    { name: "compacted final", fact: completion, messages: [] },
    { name: "ambiguous identity", fact: completion, messages: [assistant, { ...assistant }] },
    {
      name: "different timestamp",
      fact: completion,
      messages: [{ ...assistant, timestamp: 13 }],
    },
    {
      name: "different response",
      fact: completion,
      messages: [{ ...assistant, responseId: "other" }],
    },
    {
      name: "different turn",
      fact: completion,
      messages: [{ ...assistant, turnId: "other" }],
    },
    {
      name: "edited content",
      fact: completion,
      messages: [{ ...assistant, content: [{ type: "text" as const, text: "Other answer." }] }],
    },
    {
      name: "tool call appended to the captured final",
      fact: completion,
      messages: [
        {
          ...assistant,
          content: [
            ...assistant.content,
            { type: "toolCall" as const, id: "later-call", name: "message", arguments: {} },
          ],
        },
      ],
    },
  ])("preserves history for $name", ({ fact, messages }) => {
    expect(projectUndeliveredExecCompletion(messages, fact)).toBe(messages);
  });
});
