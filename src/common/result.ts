import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool answers with one JSON text block so the output is easy to read and to parse. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Runs a tool body and turns a thrown error into an MCP error result, so Claude sees Prometheus's message. */
export async function guarded(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await body());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
