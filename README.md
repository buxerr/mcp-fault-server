# MCP Mock Server for Deterministic Fault-Injection Tests

A dependency-free Node.js MCP server fixture for integration tests. It serves `initialize`, `ping`, `tools/list`, and schema-checked `tools/call` over newline-delimited stdio JSON-RPC, with ordered fault rules for timeouts, malformed responses, permission errors, and partial tool failures.

Use it to test how an MCP client handles repeatable protocol and tool failures without contacting a model provider.

## Run the fixture

Requires Node.js 20 or newer:

```sh
git clone https://github.com/buxerr/mcp-fault-server.git
cd mcp-fault-server
npm install
npm test
node src/cli.js fixtures/basic.json
```

The sample fixture defines a schema-checked `lookup` tool and injects a JSON-RPC permission error on its second call. Protocol replies go to stdout; diagnostics go to stderr.

## Define tools and inject failures

Configure fixed tool results with `toolResults` and ordered entries in `faults`. A fault rule targets a 1-based occurrence of a method or a method/tool pair. A tool-specific rule takes precedence over a method-wide rule at the same occurrence.

Supported modes include:

- `timeout`: emit no response for the matching request
- `malformed`: emit the configured raw line
- `rpc-error`: return a JSON-RPC error
- `tool-error`: return an MCP tool result marked `isError`

The input-schema validator supports string, number, integer, and boolean properties, required keys, enums, numeric bounds, string-length bounds, and `additionalProperties`. It is an intentional JSON Schema subset, not a complete validator.

The programmatic API exposes `MCPMockServer.handleLine` for a single input line and `serveStdio` for newline-delimited stdio. `handleLine` returns a response line, `null` for a notification or injected timeout, or the configured malformed line.

## Scope and limitations

This fixture covers deterministic tools-only MCP servers. It does not implement resources, prompts, sampling, OAuth, full JSON Schema, client negotiation, or a model provider. Injected timeouts do not sleep; clients should enforce their own timeout.

## License

MIT. See [LICENSE](LICENSE).
