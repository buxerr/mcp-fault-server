#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { MCPMockServer } from "./index.js";
import { serveStdio } from "./stdio.js";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("Usage: mcp-fault-server <fixture.json>\n");
  process.exitCode = 2;
} else {
  try {
    const fixture = JSON.parse(await readFile(configPath, "utf8"));
    await serveStdio(new MCPMockServer(fixture));
  } catch (error) {
    process.stderr.write("mcp-fault-server: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
