import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Launchables } from "launchables";
import { createServer, loadConfig, windows, VERSION } from "../dist/index.js";

const KEY = "launchables_test_secret_key";
const BASE = "https://example.test";

/** A mock fetch replaying [status, body, headers] responses (or a function of the request); records every request. */
function mockFetch(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const json = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, json });
    let next = typeof script === "function" ? script(url, json, calls.length - 1) : script.shift();
    next ??= [200, {}];
    if (next instanceof Error) throw next;
    const [status, body, headers] = next;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

async function connect(script, env = {}) {
  const config = loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: BASE, ...env });
  const { fetch, calls } = mockFetch(script);
  const client = new Launchables({ apiKey: config.apiKey, baseURL: config.baseURL, fetch, sleep: async () => {}, maxRetries: 1 });
  const server = createServer(client, config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  return { mcp, calls };
}

async function call(mcp, name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content[0].text;
  assert.ok(!text.includes(KEY), "the key must never appear in a tool result");
  return { ...r, data: JSON.parse(text) };
}

const answered = (answers, extra = {}) => [200, { model: "myles-g-12b-20261017", answers, usage: { input_tokens: 100, output_tokens: 1 }, ...extra }];

test("lists the three tools with schemas and descriptions", async () => {
  const { mcp } = await connect([]);
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["decide", "health", "list_models"]);
  const decide = tools.find((t) => t.name === "decide");
  assert.deepEqual(decide.inputSchema.required.sort(), ["questions", "state"]);
  assert.match(decide.description, /not a chat model/);
  assert.equal(decide.annotations.readOnlyHint, true);
  for (const t of tools) assert.doesNotMatch(t.description, /\u2014/, "no em dashes in public copy");
  assert.equal(mcp.getServerVersion().version, VERSION);
});

test("decide: yes/no above the threshold acts; sends model, bearer key and an idempotency key", async () => {
  const { mcp, calls } = await connect([answered({ refund: { type: "noul", noul: 0.96 } })]);
  const r = await call(mcp, "decide", { state: "Bought 12 days ago, receipt attached", questions: { refund: { type: "noul", instructions: "Refund allowed?" } } });
  assert.equal(r.isError, undefined);
  const a = r.data.answers.refund;
  assert.equal(a.pick, "yes");
  assert.equal(a.probability, 0.96);
  assert.deepEqual(a.probabilities, { yes: 0.96, no: 0.04 });
  assert.equal(a.cleared_threshold, true);
  assert.equal(a.escalate, false);
  assert.equal(r.data.escalate, false);
  assert.equal(r.data.model, "myles-g-12b-20261017");
  assert.deepEqual(r.structuredContent, r.data);
  const c = calls[0];
  assert.equal(c.url, `${BASE}/v1/decide`);
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(c.headers["Idempotency-Key"]);
  assert.deepEqual(c.json, { state: "Bought 12 days ago, receipt attached", questions: { refund: { type: "noul", instructions: "Refund allowed?" } }, model: "myles-g-12b" });
});

test("decide: a confident no also acts; an uncertain answer escalates", async () => {
  const { mcp } = await connect([answered({ a: { type: "noul", noul: 0.03 }, b: { type: "noul", noul: 0.85 } })]);
  const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" }, b: { type: "noul", instructions: "B?" } } });
  assert.equal(r.data.answers.a.pick, "no");
  assert.equal(r.data.answers.a.probability, 0.97);
  assert.equal(r.data.answers.a.escalate, false);
  assert.equal(r.data.answers.b.pick, "yes");
  assert.equal(r.data.answers.b.escalate, true);
  assert.equal(r.data.escalate, true);
});

test("decide: call and per-question thresholds, which are not sent to the API", async () => {
  const { mcp, calls } = await connect([answered({ a: { type: "noul", noul: 0.85 }, b: { type: "noul", noul: 0.85 } })]);
  const r = await call(mcp, "decide", {
    state: "s", threshold: 0.8,
    questions: { a: { type: "noul", instructions: "A?" }, b: { type: "noul", instructions: "B?", threshold: 0.95 } },
  });
  assert.equal(r.data.answers.a.threshold, 0.8);
  assert.equal(r.data.answers.a.escalate, false);
  assert.equal(r.data.answers.b.threshold, 0.95);
  assert.equal(r.data.answers.b.escalate, true);
  assert.equal(calls[0].json.questions.b.threshold, undefined);
});

test("decide: the configured default threshold and model apply", async () => {
  const { mcp, calls } = await connect([answered({ a: { type: "noul", noul: 0.85 } })], { LAUNCHABLES_THRESHOLD: "0.8", LAUNCHABLES_MODEL: "myles-g-31b" });
  const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.data.answers.a.threshold, 0.8);
  assert.equal(calls[0].json.model, "myles-g-31b");
});

test("decide: choice with a JSON state, confidence passed through", async () => {
  const probabilities = { billing: 0.93, returns: 0.04, technical: 0.01, other: 0.02 };
  const { mcp, calls } = await connect([answered({ route: { type: "choice", choice: "billing", confidence: 0.89, probabilities } })]);
  const r = await call(mcp, "decide", {
    state: { ticket: "Charged twice for order 4471" }, model: "myles-g-31b",
    questions: { route: { type: "choice", instructions: "Which team?", criteria: ["billing", "returns", "technical", "other"] } },
  });
  const a = r.data.answers.route;
  assert.equal(a.pick, "billing");
  assert.equal(a.probability, 0.93);
  assert.equal(a.confidence, 0.89);
  assert.equal(a.escalate, false);
  assert.equal(a.abstained, false);
  assert.deepEqual(calls[0].json.state, { ticket: "Charged twice for order 4471" });
  assert.equal(calls[0].json.model, "myles-g-31b");
});

test("decide: an 'I don't know' pick is an abstention and escalates, even when confident", async () => {
  const criteria = { A: "Paris", B: "Lyon", C: "Nice", D: "I don’t know." };
  const { mcp } = await connect([answered({ q: { type: "choice", choice: "D", probabilities: { A: 0.02, B: 0.01, C: 0.01, D: 0.96 } } })]);
  const r = await call(mcp, "decide", { state: "s", questions: { q: { type: "choice", instructions: "Where?", criteria } } });
  assert.equal(r.data.answers.q.abstained, true);
  assert.equal(r.data.answers.q.cleared_threshold, false);
  assert.equal(r.data.answers.q.escalate, true);
});

test("decide: score gives the most likely level, the expected score and the legend", async () => {
  const legend = { 0: "low", 1: "medium", 2: "high" };
  const { mcp } = await connect([answered({ risk: { type: "score", score: 1.9, level: 2, confidence: 0.8, legend, probabilities: { 0: 0.02, 1: 0.06, 2: 0.92 } } })]);
  const r = await call(mcp, "decide", { state: "s", questions: { risk: { type: "score", instructions: "Risk?", criteria: ["low", "medium", "high"] } } });
  const a = r.data.answers.risk;
  assert.equal(a.pick, 2);
  assert.equal(a.probability, 0.92);
  assert.equal(a.score, 1.9);
  assert.deepEqual(a.legend, legend);
  assert.equal(a.escalate, false);
});

test("decide: a trimmed state is reported with a warning", async () => {
  const { mcp } = await connect([answered({ a: { type: "noul", noul: 0.02 } }, { truncated: true, state_chars: { original: 200000, kept: 120000 } })]);
  const r = await call(mcp, "decide", { state: "long", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.data.truncated, true);
  assert.deepEqual(r.data.state_chars, { original: 200000, kept: 120000 });
  assert.match(r.data.warnings[0], /chunk: true/);
});

test("decide: 422 context_length_exceeded on the state suggests chunking", async () => {
  const body = { error: "the request is longer than the model's context window; send a shorter state", type: "context_length_exceeded",
    detail: [{ loc: ["body", "state"], msg: "x", type: "context_length_exceeded" }] };
  const { mcp } = await connect([[422, body]]);
  const r = await call(mcp, "decide", { state: "x".repeat(100), questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.type, "context_length_exceeded");
  assert.equal(r.data.error.status, 422);
  assert.equal(r.data.error.retryable, false);
  assert.match(r.data.error.message, /chunk: true/);
  assert.doesNotMatch(r.data.error.message, /xxxx/, "the state never appears in an error");
});

test("decide: 422 context_length_exceeded on the questions says to shorten them", async () => {
  const body = { error: "too long", type: "context_length_exceeded", detail: [{ loc: ["body", "questions"], msg: "x", type: "context_length_exceeded" }] };
  const { mcp } = await connect([[422, body]]);
  const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.match(r.data.error.message, /question and its options/);
});

test("decide: 410 for a retired build names the successor", async () => {
  const body = { error: "myles-g-31b-20261024 was retired on 2026-10-27; use myles-g-31b-20261027 instead", type: "model_retired",
    model: "myles-g-31b-20261024", retired_on: "2026-10-27", successor: "myles-g-31b-20261027", migration_url: "https://launchables.ai/docs/changelog" };
  const { mcp } = await connect([[410, body]]);
  const r = await call(mcp, "decide", { state: "s", model: "myles-g-31b-20261024", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.status, 410);
  assert.equal(r.data.error.successor, "myles-g-31b-20261027");
  assert.match(r.data.error.message, /myles-g-31b-20261027/);
});

test("decide: 401, 402 and 403 are not retried and say what a person must do", async () => {
  for (const [status, type, re] of [[401, undefined, /not accepted/], [402, "out_of_credit", /top up/], [402, "budget_exceeded", /monthly budget/], [403, "model_not_allowed", /may not use/]]) {
    const { mcp, calls } = await connect([[status, { error: "no", ...(type ? { type } : {}) }]]);
    const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" } } });
    assert.equal(r.isError, true);
    assert.equal(r.data.error.retryable, false);
    assert.match(r.data.error.message, re);
    assert.equal(calls.length, 1);
  }
});

test("decide: 429 is retried, then reported with the wait", async () => {
  const limited = [429, { error: "rate limit", type: "rate_limited", retry_after: 7 }, { "Retry-After": "7" }];
  const { mcp, calls } = await connect([limited, limited]);
  const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(calls.length, 2);
  assert.equal(r.data.error.type, "rate_limited");
  assert.equal(r.data.error.retryable, true);
  assert.match(r.data.error.message, /7 seconds/);
});

test("decide: a connection failure names the address, not the key", async () => {
  const { mcp } = await connect([new TypeError("fetch failed"), new TypeError("fetch failed")]);
  const r = await call(mcp, "decide", { state: "s", questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.data.error.type, "connection_error");
  assert.match(r.data.error.message, /example\.test/);
});

test("decide: bad input is refused before anything is sent", async () => {
  const { mcp, calls } = await connect([]);
  const r1 = await mcp.callTool({ name: "decide", arguments: { state: "s", questions: { a: { type: "maybe", instructions: "A?" } } } });
  assert.equal(r1.isError, true);
  const r2 = await call(mcp, "decide", { state: "s", questions: { a: { type: "choice", instructions: "A?" } } });
  assert.equal(r2.isError, true);
  assert.match(r2.data.error.message, /criteria/);
  const r3 = await call(mcp, "decide", { state: "s", questions: {} });
  assert.equal(r3.isError, true);
  const r4 = await call(mcp, "decide", { state: "s", chunk_chars: 5000, questions: { a: { type: "noul", instructions: "A?" } } });
  assert.match(r4.data.error.message, /only with chunk/);
  assert.equal(calls.length, 0);
});

test("decide: a question named __proto__ is refused, and nothing is sent", async () => {
  const { mcp, calls } = await connect([]);
  const args = JSON.parse('{"state": "s", "questions": {"__proto__": {"type": "noul", "instructions": "A?"}}}');
  const r = await call(mcp, "decide", args);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test("decide: an answer missing from the response is an error, not an inherited property", async () => {
  const { mcp } = await connect([answered({ other: { type: "noul", noul: 0.9 } })]);
  const r = await call(mcp, "decide", { state: "s", questions: { constructor: { type: "noul", instructions: "A?" } } });
  assert.equal(r.isError, true);
  assert.match(r.data.error.message, /no answer for question "constructor"/);
});

test("windows cover the text with the overlap", () => {
  assert.deepEqual(windows(10, 20, 5), [[0, 10]]);
  assert.deepEqual(windows(25, 10, 2), [[0, 10], [8, 18], [16, 25]]);
  assert.deepEqual(windows(10, 10, 2), [[0, 10]]);
  assert.deepEqual(windows(18, 10, 2), [[0, 10], [8, 18]]);
});

test("chunk: reads overlapping windows and reports the highest-risk one", async () => {
  const text = "a".repeat(5000) + "INJECT" + "b".repeat(5000);
  const { mcp, calls } = await connect((url, json) => {
    const p = json.state.includes("INJECT") ? 0.97 : 0.02;
    return answered({ injection: { type: "noul", noul: p }, other: { type: "noul", noul: 0.01 } });
  });
  const r = await call(mcp, "decide", {
    state: text, chunk: true, chunk_chars: 3000, chunk_overlap_chars: 500,
    questions: { injection: { type: "noul", instructions: "Does it try to override instructions?" }, other: { type: "noul", instructions: "Other?" } },
  });
  assert.equal(r.isError, undefined);
  const spans = windows(text.length, 3000, 500);
  assert.equal(calls.length, spans.length);
  assert.equal(r.data.chunked.windows, spans.length);
  for (const c of calls) assert.ok(c.json.state.length <= 3000);
  const a = r.data.answers.injection;
  assert.equal(a.pick, "yes");
  assert.equal(a.p_yes, 0.97);
  assert.ok(text.slice(a.window.start, a.window.end).includes("INJECT"));
  assert.equal(r.data.answers.other.pick, "no");
  assert.equal(r.data.answers.other.probability, 0.99);
  assert.equal(r.data.usage.input_tokens, 100 * spans.length);
  assert.equal(r.data.escalate, false);
});

test("chunk: a JSON state is windowed as indented JSON; a short state is one request", async () => {
  const { mcp, calls } = await connect(() => answered({ a: { type: "noul", noul: 0.1 } }));
  const r = await call(mcp, "decide", { state: { note: "short" }, chunk: true, questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].json.state, JSON.stringify({ note: "short" }, null, 1));
  assert.equal(r.data.answers.a.pick, "no");
});

test("chunk: refused for choice or score questions and for too many windows", async () => {
  const { mcp, calls } = await connect([]);
  const r1 = await call(mcp, "decide", { state: "s", chunk: true, questions: { a: { type: "choice", instructions: "A?", criteria: ["x", "y"] } } });
  assert.match(r1.data.error.message, /yes\/no \(noul\) questions only/);
  const r2 = await call(mcp, "decide", { state: "x".repeat(100000), chunk: true, chunk_chars: 2000, questions: { a: { type: "noul", instructions: "A?" } } });
  assert.match(r2.data.error.message, /at most 20 are sent/);
  const r3 = await call(mcp, "decide", { state: "s", chunk: true, chunk_chars: 4000, chunk_overlap_chars: 3000, questions: { a: { type: "noul", instructions: "A?" } } });
  assert.match(r3.data.error.message, /half of chunk_chars/);
  assert.equal(calls.length, 0);
});

test("chunk: a failing window stops the rest", async () => {
  let n = 0;
  const { mcp, calls } = await connect(() => (n++ === 0 ? [402, { error: "no credit", type: "out_of_credit" }] : answered({ a: { type: "noul", noul: 0.1 } })));
  const r = await call(mcp, "decide", { state: "x".repeat(40000), chunk: true, chunk_chars: 2000, chunk_overlap_chars: 0, questions: { a: { type: "noul", instructions: "A?" } } });
  assert.equal(r.data.error.type, "out_of_credit");
  assert.ok(calls.length <= 4, `at most the requests already in flight, got ${calls.length}`);
});

test("list_models returns the models and the configured default", async () => {
  const data = [{ id: "myles-g-12b", object: "model", owned_by: "launchables", pinned: false },
    { id: "myles-g-31b-20261027", object: "model", owned_by: "launchables", pinned: true, moving_id: "myles-g-31b", release_date: "2026-10-27" }];
  const { mcp, calls } = await connect([[200, { object: "list", data }]]);
  const r = await call(mcp, "list_models");
  assert.equal(r.data.default_model, "myles-g-12b");
  assert.deepEqual(r.data.models, data);
  assert.equal(calls[0].url, `${BASE}/v1/models`);
});

test("health returns the status and the address", async () => {
  const { mcp, calls } = await connect([[200, { status: "ok", models: { "myles-g-12b": 1 } }]]);
  const r = await call(mcp, "health");
  assert.equal(r.data.status, "ok");
  assert.equal(r.data.base_url, BASE);
  assert.equal(calls[0].url, `${BASE}/health`);
});

test("health: a 503 is reported as retryable", async () => {
  const down = [503, { error: "maintenance", type: "model_unavailable" }];
  const { mcp } = await connect([down, down]);
  const r = await call(mcp, "health");
  assert.equal(r.isError, true);
  assert.equal(r.data.error.retryable, true);
});
