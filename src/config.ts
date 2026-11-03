import { DEFAULT_BASE_URL } from "launchables";

export const DEFAULT_MODEL = "myles-g-12b";
export const DEFAULT_THRESHOLD = 0.9;
export const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * The most one tool call may take in all, retries and waits included. Some hosts stop a tool call after 30 seconds, so the
 * default ends it first, with an error the agent can read, rather than leaving it to be cut off without one.
 */
export const DEFAULT_TOTAL_TIMEOUT_SECONDS = 25;
export const MAX_TOTAL_TIMEOUT_SECONDS = 600;
/** A threshold is the probability the picked option must reach; below 0.5 a "yes" could clear it with "no" more likely. */
export const MIN_THRESHOLD = 0.5;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  threshold: number;
  /** One attempt's timeout (LAUNCHABLES_TIMEOUT_MS). */
  timeoutMs: number;
  /** A whole tool call's timeout, every attempt and wait included (LAUNCHABLES_TIMEOUT_SECONDS), in milliseconds. */
  totalTimeoutMs: number;
  /** LAUNCHABLES_LOCK_MODEL: every call uses `model`; a call that names a model is refused. */
  lockModel: boolean;
  /** LAUNCHABLES_LOCK_THRESHOLD: every answer uses `threshold`; a call or question that sets one is refused. */
  lockThreshold: boolean;
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

/** An on/off setting: 1 or true is on, 0, false or unset is off; anything else is refused rather than guessed. */
function parseFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "" || v === "0" || v === "false") return false;
  throw new ConfigError(`${name} must be 1 (on) or 0 (off), got ${JSON.stringify(raw)}`);
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

  let totalSeconds = DEFAULT_TOTAL_TIMEOUT_SECONDS;
  if (env.LAUNCHABLES_TIMEOUT_SECONDS !== undefined) {
    const raw = env.LAUNCHABLES_TIMEOUT_SECONDS;
    totalSeconds = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(totalSeconds) || totalSeconds < 1 || totalSeconds > MAX_TOTAL_TIMEOUT_SECONDS) {
      throw new ConfigError(`LAUNCHABLES_TIMEOUT_SECONDS must be a number of seconds from 1 to ${MAX_TOTAL_TIMEOUT_SECONDS}, got ${JSON.stringify(raw)}`);
    }
  }

  return {
    apiKey,
    baseURL: url.toString().replace(/\/+$/, ""),
    model,
    threshold,
    timeoutMs,
    totalTimeoutMs: Math.round(totalSeconds * 1000),
    lockModel: parseFlag(env, "LAUNCHABLES_LOCK_MODEL"),
    lockThreshold: parseFlag(env, "LAUNCHABLES_LOCK_THRESHOLD"),
  };
}
