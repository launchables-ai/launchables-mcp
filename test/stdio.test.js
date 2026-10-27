// The real command over stdio, against a local mock of the Decision API (no production calls).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const KEY = "launchables_stdio_secret_key";

test("the command answers over stdio and keeps the key and the state out of its output", async () => {
  const seen = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
      res.end(JSON.stringify({ model: "myles-g-12b", answers: { flag: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 9, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const { port } = api.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { PATH: process.env.PATH ?? "", LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: `http://127.0.0.1:${port}` },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const mcp = new Client({ name: "stdio-test", version: "0" });
  try {
    await mcp.connect(transport);
    const r = await mcp.callTool({ name: "decide", arguments: { state: "SECRET-STATE-TEXT", questions: { flag: { type: "noul", instructions: "Flag it?" } } } });
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.answers.flag.pick, "yes");
    assert.equal(data.escalate, false);
    const h = await mcp.callTool({ name: "health", arguments: {} });
    assert.equal(JSON.parse(h.content[0].text).status, "ok");
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.match(seen[0].body, /SECRET-STATE-TEXT/);
  } finally {
    await mcp.close();
    api.close();
  }
  assert.ok(!stderr.includes(KEY), "the key is never logged");
  assert.ok(!stderr.includes("SECRET-STATE-TEXT"), "the state is never logged");
});

test("a missing key stops the command with a clear message on stderr", () => {
  const r = spawnSync(process.execPath, [CLI], { env: { PATH: process.env.PATH ?? "" }, input: "", encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /LAUNCHABLES_API_KEY/);
});

test("--version prints the version", () => {
  const r = spawnSync(process.execPath, [CLI, "--version"], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});
