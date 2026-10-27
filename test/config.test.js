import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError, DEFAULT_MODEL, DEFAULT_THRESHOLD } from "../dist/index.js";

const KEY = "launchables_test_secret_key";

test("defaults: hosted API, myles-g-12b, threshold 0.9", () => {
  const c = loadConfig({ LAUNCHABLES_API_KEY: KEY });
  assert.equal(c.apiKey, KEY);
  assert.equal(c.baseURL, "https://api.launchables.ai");
  assert.equal(c.model, DEFAULT_MODEL);
  assert.equal(c.model, "myles-g-12b");
  assert.equal(c.threshold, DEFAULT_THRESHOLD);
  assert.equal(c.timeoutMs, 60000);
});

test("LAUNCHABLES_API_TOKEN, the SDKs' name, is accepted too; LAUNCHABLES_API_KEY wins", () => {
  assert.equal(loadConfig({ LAUNCHABLES_API_TOKEN: "t" }).apiKey, "t");
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: "k", LAUNCHABLES_API_TOKEN: "t" }).apiKey, "k");
});

test("a missing key is refused without echoing anything secret", () => {
  assert.throws(() => loadConfig({}), (e) => e instanceof ConfigError && /LAUNCHABLES_API_KEY/.test(e.message));
  assert.throws(() => loadConfig({ LAUNCHABLES_API_KEY: "  " }), ConfigError);
});

test("self-hosted base URL, trailing slash removed", () => {
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: "https://myles.internal.example/" }).baseURL, "https://myles.internal.example");
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: "http://127.0.0.1:8000" }).baseURL, "http://127.0.0.1:8000");
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: "http://localhost:8000/" }).baseURL, "http://localhost:8000");
});

test("plain http to another machine needs LAUNCHABLES_ALLOW_HTTP=1", () => {
  const env = { LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: "http://10.0.0.5:8000" };
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && !e.message.includes(KEY));
  assert.equal(loadConfig({ ...env, LAUNCHABLES_ALLOW_HTTP: "1" }).baseURL, "http://10.0.0.5:8000");
});

test("bad base URLs are refused", () => {
  for (const url of ["not a url", "ftp://x.example", "https://user:pw@x.example", "https://x.example/?a=1"]) {
    assert.throws(() => loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_BASE_URL: url }), ConfigError, url);
  }
});

test("model, threshold and timeout are checked", () => {
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_MODEL: "myles-g-31b-20261027" }).model, "myles-g-31b-20261027");
  assert.throws(() => loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_MODEL: "Bad Model" }), ConfigError);
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_THRESHOLD: "0.95" }).threshold, 0.95);
  for (const t of ["0.4", "1.1", "", "x"]) {
    assert.throws(() => loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_THRESHOLD: t }), ConfigError, t);
  }
  assert.equal(loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_TIMEOUT_MS: "120000" }).timeoutMs, 120000);
  assert.throws(() => loadConfig({ LAUNCHABLES_API_KEY: KEY, LAUNCHABLES_TIMEOUT_MS: "5" }), ConfigError);
});
