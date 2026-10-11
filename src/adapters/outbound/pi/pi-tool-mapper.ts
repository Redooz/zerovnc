// Maps the application tool set to Pi tool definitions. Schemas are passed through as JSON
// Schema (TypeBox Unsafe wrapper); results are mapped to Pi content blocks. Desktop tools run
// sequentially. No business logic here: every call is delegated to the ToolSet.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ToolSet } from "../../../application/tools/contract.ts";

export function toPiTools(tools: ToolSet): AgentTool[] {
  return tools.descriptors().map((descriptor) => ({
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    parameters: Type.Unsafe<Record<string, unknown>>(descriptor.parameters),
    executionMode: "sequential",
    async execute(toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
      const result = await tools.invoke(descriptor.name, params, {
        invocationId: toolCallId,
        signal: signal ?? new AbortController().signal,
      });
      return {
        content: [{ type: "text", text: result.message }],
        details: { status: result.status },
        isError: result.status !== "ok",
      };
    },
  }));
}
