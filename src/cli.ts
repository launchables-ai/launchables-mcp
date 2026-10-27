#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Launchables } from "launchables";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // stdout carries the protocol: every message goes to stderr, and never the key
    process.stderr.write(`launchables-mcp: ${e instanceof ConfigError ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const client = new Launchables({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs });
  const server = createServer(client, config);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`launchables-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
