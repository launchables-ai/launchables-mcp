import { AsyncLocalStorage } from "node:async_hooks";

/** The tool call's deadline signal, for the fetch and sleep below to honour. */
const current = new AsyncLocalStorage<AbortSignal>();

/** A tool call ran out of its total time (LAUNCHABLES_TIMEOUT_SECONDS), retries and waits included. */
export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`the call took longer than ${ms / 1000} seconds in all`);
    this.name = "DeadlineError";
  }
}

/**
 * Runs `work` with a total deadline. When it passes, the call ends at once with a DeadlineError, and a client made with
 * deadlineFetch and deadlineSleep stops too: its request in flight is aborted and no further attempt is sent.
 */
export async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new DeadlineError(ms);
      controller.abort(e);
      reject(e);
    }, ms);
  });
  // run as an async function, so a `work` that throws before returning its promise still rejects inside the race
  const running = current.run(controller.signal, async () => work());
  // once the deadline has answered, the abandoned work's own failure has nowhere to go
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A signal that aborts when either does, with that one's reason. (AbortSignal.any is missing before Node.js 20.3.) */
function either(a: AbortSignal, b: AbortSignal): AbortSignal {
  const both = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) {
      both.abort(s.reason);
      return both.signal;
    }
  }
  const stop = (s: AbortSignal) => () => both.abort(s.reason);
  a.addEventListener("abort", stop(a), { once: true, signal: both.signal });
  b.addEventListener("abort", stop(b), { once: true, signal: both.signal });
  return both.signal;
}

/** A fetch that is also aborted by the deadline of the tool call it runs in. */
export function deadlineFetch(base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const doFetch = base ?? globalThis.fetch;
    const deadline = current.getStore();
    if (!deadline) return doFetch(input, init);
    if (deadline.aborted) return Promise.reject(deadline.reason);
    // the caller's own signal is kept: the one in init, or else the one a Request carries
    const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = own ? either(own, deadline) : deadline;
    return doFetch(input, { ...init, signal });
  };
}

/** A sleep (the wait between retries) that ends early, with the deadline's error, when the tool call's deadline passes. */
export function deadlineSleep(ms: number): Promise<void> {
  const deadline = current.getStore();
  if (deadline?.aborted) return Promise.reject(deadline.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(deadline?.reason);
    };
    const timer = setTimeout(() => {
      deadline?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    deadline?.addEventListener("abort", onAbort, { once: true });
  });
}
