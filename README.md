# MCP Fault Server

A dependency-free MCP server fixture for integration tests. It answers initialize, ping, tools/list, and schema-checked tools/call requests over newline-delimited stdio JSON-RPC. Ordered fault rules can simulate missing responses, malformed lines, permission errors, and tool-level partial failures.

## Run

Use Node.js 20 or newer. Run npm test to execute the built-in test suite. Install the package and launch mcp-fault-server fixtures/basic.json to run the sample stdio server. It writes protocol replies only to stdout and diagnostics only to stderr.

## Fixture model

Define tools with a bounded object input schema. The validator supports string, number, integer, and boolean properties, required keys, enums, numeric bounds, string-length bounds, and additionalProperties. This is an intentional JSON Schema subset, not a full validator.

Configure fixed result sequences in toolResults. After the last result, the server repeats that result. Fault rules use a 1-based occurrence for a method or a method/tool pair. A tool-specific rule takes precedence over a method-wide rule at the same request. A timeout means no reply is emitted; malformed sends the configured raw line; rpc-error returns a JSON-RPC error; tool-error returns an MCP tool result marked isError.

## API

Create an MCPMockServer with tool definitions and fault rules, then call handleLine for one input JSON-RPC line. It returns one response line, null for a notification or injected timeout, or the injected malformed line. serveStdio binds this handler to stdin/stdout and pauses input during output backpressure.

## Scope

This project covers deterministic tools-only server fixtures. It does not implement resources, prompts, sampling, OAuth, full JSON Schema, client negotiation, or a real model provider. It does not sleep for injected timeouts, so tests stay deterministic; clients should enforce their own timeout.

MIT licensed. See LICENSE.
