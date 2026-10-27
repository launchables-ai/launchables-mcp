import { DEFAULT_BASE_URL } from "launchables";

export const DEFAULT_MODEL = "myles-g-12b";
export const DEFAULT_THRESHOLD = 0.9;
export const DEFAULT_TIMEOUT_MS = 60_000;
/** A threshold is the probability the picked option must reach; below 0.5 a "yes" could clear it with "no" more likely. */
export const MIN_THRESHOLD = 0.5;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  threshold: number;
  timeoutMs: number;
}

/** A configuration problem, reported once at start-up. The message never contains the API key. */
export class ConfigError extends Error {}

function parseThreshold(raw: string): number {
  const t = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(t) || t < MIN_THRESHOLD || t > 1) {
    throw new ConfigError(`LAUNCHABLES_THRESHOLD must be a number from ${MIN_THRESHOLD} to 1, got ${JSON.stringify(raw)}`);
  }
  return t;
}

/**
 * Reads the configuration from the environment. The key is LAUNCHABLES_API_KEY, or LAUNCHABLES_API_TOKEN (the name the
 * Launchables SDKs and docs use), so an existing setup works unchanged.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.LAUNCHABLES_API_KEY || env.LAUNCHABLES_API_TOKEN || "").trim();
  if (!apiKey) {
    throw new ConfigError(
      "No API key. Set LAUNCHABLES_API_KEY (or LAUNCHABLES_API_TOKEN) to a key from https://console.launchables.ai.",
    );
  }

  const rawURL = (env.LAUNCHABLES_BASE_URL || DEFAULT_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw new ConfigError(`LAUNCHABLES_BASE_URL is not a valid URL: ${JSON.stringify(rawURL)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("LAUNCHABLES_BASE_URL must start with https:// (or http:// for a server on this machine)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("LAUNCHABLES_BASE_URL must be a plain address, without credentials, a query or a fragment");
  }
  // the key goes in every request's Authorization header: never send it unencrypted over a network
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname) && env.LAUNCHABLES_ALLOW_HTTP !== "1") {
    throw new ConfigError(
      "LAUNCHABLES_BASE_URL uses http:// for a server that is not on this machine, which would send the API key unencrypted. " +
        "Use https://, or set LAUNCHABLES_ALLOW_HTTP=1 if the network between you and the server is trusted.",
    );
  }

  const model = (env.LAUNCHABLES_MODEL || DEFAULT_MODEL).trim();
  if (!MODEL_ID.test(model)) throw new ConfigError(`LAUNCHABLES_MODEL is not a model id: ${JSON.stringify(model)}`);

  const threshold = env.LAUNCHABLES_THRESHOLD === undefined ? DEFAULT_THRESHOLD : parseThreshold(env.LAUNCHABLES_THRESHOLD);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (env.LAUNCHABLES_TIMEOUT_MS !== undefined) {
    timeoutMs = Number(env.LAUNCHABLES_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
      throw new ConfigError("LAUNCHABLES_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000");
    }
  }

  return { apiKey, baseURL: url.toString().replace(/\/+$/, ""), model, threshold, timeoutMs };
}
