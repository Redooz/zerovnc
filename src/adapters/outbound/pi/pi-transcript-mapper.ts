// Maps the application transcript to Pi messages and back. Pure mapping: no business
// decisions. Only assistant turns and tool results come back from the SDK; instructions and
// state snapshots are owned by the application.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage, Usage } from "@earendil-works/pi-ai";
import type { TranscriptEntry } from "../../../application/agent/transcript.ts";
import type { ToolStatus } from "../../../application/tools/contract.ts";

// Provider label for messages produced by this adapter. Pi needs one; the real route is the OpenRouter model id.
export const PI_API = "openrouter-chat";
export const PI_PROVIDER = "openrouter";

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toPiMessages(entries: readonly TranscriptEntry[], model: string, now: () => number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    const timestamp = now();
    switch (entry.kind) {
      case "user": {
        const message: UserMessage = { role: "user", content: entry.text, timestamp };
        out.push(message);
        break;
      }
      case "assistant": {
        const content: AssistantMessage["content"] = [];
        if (entry.text !== "") content.push({ type: "text", text: entry.text });
        for (const call of entry.toolCalls) {
          const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments as ToolCall["arguments"] };
          content.push(toolCall);
        }
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: PI_API,
          provider: PI_PROVIDER,
          model,
          usage: zeroUsage(),
          stopReason: entry.toolCalls.length > 0 ? "toolUse" : "stop",
          timestamp,
        };
        out.push(message);
        break;
      }
      case "tool_result": {
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          content: [{ type: "text", text: entry.text }],
          // The application status (ok, refused, failed) travels in details; isError only marks non-ok.
          details: { status: entry.status },
          isError: entry.status !== "ok",
          timestamp,
        };
        out.push(message);
        break;
      }
    }
  }
  return out;
}

// Converts messages produced during a cycle. System messages and user messages are not returned:
// the application already holds them.
export function fromPiMessages(messages: readonly AgentMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const toolCalls = message.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments as Readonly<Record<string, unknown>> }));
      out.push({ kind: "assistant", text, toolCalls });
    } else if (message.role === "toolResult") {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      out.push({
        kind: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        status: statusOf(message),
        text,
      });
    }
  }
  return out;
}

function statusOf(message: ToolResultMessage): ToolStatus {
  const details = message.details as { status?: unknown } | undefined;
  if (details?.status === "ok" || details?.status === "refused" || details?.status === "failed") return details.status;
  return message.isError ? "failed" : "ok";
}
