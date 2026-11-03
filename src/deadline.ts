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
  const running = current.run(controller.signal, work);
  // once the deadline has answered, the abandoned work's own failure has nowhere to go
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch that is also aborted by the deadline of the tool call it runs in. */
export function deadlineFetch(base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const doFetch = base ?? globalThis.fetch;
    const deadline = current.getStore();
    if (!deadline) return doFetch(input, init);
    if (deadline.aborted) return Promise.reject(deadline.reason);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
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
