import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { MCPMockServer, MockConfigError, stableStringify } from "../src/index.js";
import { serveStdio } from "../src/stdio.js";

const tool = {
  name: "lookup",
  description: "Look up one bounded key.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", minLength: 1, maxLength: 20 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["key"],
    additionalProperties: false,
  },
};

function request(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function response(server, line) {
  const serialized = server.handleLine(line);
  return serialized === null ? null : JSON.parse(serialized);
}

test("serves initialize, tool listing, and schema-checked calls", () => {
  const server = new MCPMockServer({ tools: [tool] });
  const initialized = response(server, request(1, "initialize", { protocolVersion: "2025-11-25" }));
  assert.equal(initialized.result.serverInfo.name, "mcp-fault-server");
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(response(server, request(2, "tools/list")).result.tools.map((item) => item.name), ["lookup"]);
  assert.equal(
    response(server, request(3, "tools/call", { name: "lookup", arguments: { key: "abc", limit: 4 } })).result.content[0].text,
    '{"key":"abc","limit":4}',
  );
});

test("rejects missing, invalid, and extra tool arguments", () => {
  const server = new MCPMockServer({ tools: [tool] });
  assert.equal(response(server, request(1, "tools/call", { name: "lookup", arguments: {} })).error.code, -32602);
  assert.equal(response(server, request(2, "tools/call", { name: "lookup", arguments: { key: "" } })).error.code, -32602);
  assert.equal(response(server, request(3, "tools/call", { name: "lookup", arguments: { key: "x", unknown: true } })).error.code, -32602);
  assert.equal(response(server, request(4, "tools/call", { name: "missing", arguments: {} })).error.code, -32602);
});

test("serves fixed result queues and repeats the final result deterministically", () => {
  const server = new MCPMockServer({
    tools: [tool],
    toolResults: {
      lookup: [
        { content: [{ type: "text", text: "first" }] },
        { content: [{ type: "text", text: "second" }] },
      ],
    },
  });
  const call = () => response(server, request(1, "tools/call", { name: "lookup", arguments: { key: "x" } }));
  assert.equal(call().result.content[0].text, "first");
  assert.equal(call().result.content[0].text, "second");
  assert.equal(call().result.content[0].text, "second");
});

test("injects timeout, malformed output, permission error, and partial tool failure on exact occurrences", () => {
  const server = new MCPMockServer({
    tools: [tool],
    faults: [
      { method: "tools/call", toolName: "lookup", occurrence: 1, mode: "timeout" },
      { method: "tools/call", toolName: "lookup", occurrence: 2, mode: "malformed", rawLine: "{bad response" },
      { method: "tools/call", toolName: "lookup", occurrence: 3, mode: "rpc-error", code: -32003, message: "permission denied" },
      { method: "tools/call", toolName: "lookup", occurrence: 4, mode: "tool-error", message: "second batch item failed" },
    ],
  });
  const call = (id) => server.handleLine(request(id, "tools/call", { name: "lookup", arguments: { key: "x" } }));
  assert.equal(call(1), null);
  assert.equal(call(2), "{bad response");
  const denied = JSON.parse(call(3));
  assert.equal(denied.error.code, -32003);
  assert.equal(denied.error.data.retryable, false);
  const partial = JSON.parse(call(4));
  assert.equal(partial.result.isError, true);
  assert.equal(partial.result.content[0].text, "second batch item failed");
  assert.equal(JSON.parse(call(5)).result.content[0].text, '{"key":"x"}');
});

test("prefers a tool-specific fault over a method-wide fault at the same occurrence", () => {
  const server = new MCPMockServer({
    tools: [tool],
    faults: [
      { method: "tools/call", occurrence: 1, mode: "rpc-error", code: -32001, message: "global" },
      { method: "tools/call", toolName: "lookup", occurrence: 1, mode: "rpc-error", code: -32002, message: "specific" },
    ],
  });
  const result = response(server, request(1, "tools/call", { name: "lookup", arguments: { key: "x" } }));
  assert.equal(result.error.code, -32002);
});

test("does not answer notifications and handles malformed input as JSON-RPC errors", () => {
  const server = new MCPMockServer();
  assert.equal(server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
  assert.equal(JSON.parse(server.handleLine("{broken")).error.code, -32700);
  assert.equal(JSON.parse(server.handleLine('{"jsonrpc":"1.0","id":1,"method":"ping"}')).error.code, -32600);
  assert.equal(JSON.parse(server.handleLine(request(1, "unknown"))).error.code, -32601);
});

test("validates fixture structure and deterministic JSON", () => {
  assert.throws(() => new MCPMockServer({ tools: [tool, tool] }), MockConfigError);
  assert.throws(() => new MCPMockServer({ tools: [tool], faults: [{ method: "tools/call", occurrence: 0, mode: "timeout" }] }), MockConfigError);
  assert.throws(() => new MCPMockServer({ tools: [tool], faults: [{ method: "tools/call", toolName: "other", occurrence: 1, mode: "timeout" }] }), MockConfigError);
  assert.equal(stableStringify({ z: 1, a: { y: true, b: 2 } }), '{"a":{"b":2,"y":true},"z":1}');
  assert.throws(() => stableStringify({ value: Number.NaN }), TypeError);
  assert.throws(() => new MCPMockServer({ faults: {} }), MockConfigError);
  assert.throws(() => new MCPMockServer({ toolResults: [] }), MockConfigError);
  assert.throws(() => new MCPMockServer({ tools: [{ ...tool, inputSchema: {
    type: "object", properties: { key: { type: "string", minimum: 1 } },
  } }] }), MockConfigError);
});

test("returns valid JSON-RPC for an initialized notification sent with an id", () => {
  const server = new MCPMockServer();
  assert.deepEqual(response(server, request(4, "notifications/initialized")), {
    jsonrpc: "2.0", id: 4, result: {},
  });
});

test("serves newline-delimited JSON over stdio without extra stdout text", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received = "";
  output.on("data", (chunk) => { received += chunk.toString("utf8"); });
  const server = new MCPMockServer();
  const serving = serveStdio(server, { input, output });
  input.end(request(7, "ping") + "\n" + '{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await serving;
  assert.deepEqual(JSON.parse(received), { id: 7, jsonrpc: "2.0", result: {} });
  assert.equal(received.trim().split("\n").length, 1);
});
