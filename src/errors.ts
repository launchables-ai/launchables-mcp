import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  LaunchablesError,
  OutOfCreditError,
  PermissionDeniedError,
  RateLimitError,
} from "launchables";

/** A refusal raised by this server itself, before anything is sent (bad chunk settings, a threshold out of range). */
export class ToolInputError extends Error {}

export interface ToolError {
  /** What went wrong and what to do about it, written for the agent reading the tool result. */
  message: string;
  /** The API's error type when it sent one, such as "context_length_exceeded", or a code of this server's own. */
  type: string;
  status?: number;
  /** Whether the same call may succeed if tried again later, unchanged. */
  retryable: boolean;
  /** For a retired model: the model to use instead. */
  successor?: string;
}

type Body = Record<string, unknown> | undefined;

function bodyOf(e: LaunchablesError): Body {
  return typeof e.body === "object" && e.body !== null ? (e.body as Record<string, unknown>) : undefined;
}

function fieldPath(body: Body): string | undefined {
  const detail = body?.detail;
  if (!Array.isArray(detail)) return undefined;
  const loc = (detail[0] as { loc?: unknown } | undefined)?.loc;
  return Array.isArray(loc) ? loc.join(".") : undefined;
}

/**
 * Turns anything a tool call throws into a short, actionable error for the agent. It uses only the status, the error type
 * and the server's message, never the request, so a state or a key can never appear in it.
 */
export function toToolError(e: unknown, baseURL: string): ToolError {
  if (e instanceof ToolInputError) return { message: e.message, type: "invalid_input", retryable: false };
  if (!(e instanceof LaunchablesError)) {
    return { message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`, type: "internal_error", retryable: false };
  }
  const status = e.status;
  const type = e.type ?? (status === undefined ? "client_error" : `http_${status}`);
  const said = e.serverMessage;
  const body = bodyOf(e);

  if (e instanceof APIConnectionError) {
    return { message: `Could not reach the Decision API at ${baseURL}. Check the address and the network, then try again. (${said})`, type: "connection_error", retryable: true };
  }
  if (e instanceof AuthenticationError) {
    return {
      message: "The API key was missing or not accepted (wrong, expired or revoked). Ask the person who set up this tool to check LAUNCHABLES_API_KEY; a new key can be made in the console.",
      type, status, retryable: false,
    };
  }
  if (e instanceof OutOfCreditError) {
    const why = type === "budget_exceeded" ? "The key's workspace has reached its monthly budget." : "The account has no prepaid credit left.";
    return { message: `${why} Do not retry: a person must top up or raise the budget in the console. (${said})`, type, status, retryable: false };
  }
  if (e instanceof PermissionDeniedError) {
    return { message: `This key may not use that model. Use list_models to see the models, or ask for the workspace's models to be changed in the console. (${said})`, type, status, retryable: false };
  }
  if (e instanceof RateLimitError) {
    const wait = e.retryAfter !== undefined ? ` Wait ${e.retryAfter} seconds before trying again.` : " Wait a little before trying again.";
    return { message: `Rate limit reached and retries ran out.${wait} (${said})`, type, status, retryable: true };
  }
  if (status === 410 || type === "model_retired") {
    const successor = typeof body?.successor === "string" ? body.successor : undefined;
    const next = successor ? ` Call again with model "${successor}" (or set LAUNCHABLES_MODEL to it).` : " Use list_models to find a current model.";
    return { message: `That model build has been retired.${next} (${said})`, type, status, retryable: false, ...(successor ? { successor } : {}) };
  }
  if (type === "context_length_exceeded") {
    const where = fieldPath(body);
    if (where === "body.state") {
      return {
        message:
          "The state is longer than the model's context window. Send a shorter state (only what the decision needs), split it and ask about each part, or, " +
          "for yes/no checks, call decide again with chunk: true to read it in overlapping windows and take the highest-risk window. " + `(${said})`,
        type, status, retryable: false,
      };
    }
    return {
      message: `A question and its options are too long for the model's context window on their own. Shorten the instructions or the option descriptions, or split the options over several questions. (${said})`,
      type, status, retryable: false,
    };
  }
  if (type === "model_not_found") {
    return { message: `No such model. Use list_models to see the model ids this endpoint serves. (${said})`, type, status, retryable: false };
  }
  if (type === "too_many_questions" || type === "too_many_options") {
    return { message: `Too many questions or options for this model. Split them over several decide calls. (${said})`, type, status, retryable: false };
  }
  if (e instanceof APIError || (status !== undefined && status >= 500)) {
    return { message: `The Decision API could not answer right now. Try again shortly. (${said})`, type, status, retryable: true };
  }
  const where = fieldPath(body);
  return { message: `The request was refused: ${said}${where ? ` (field ${where})` : ""}. Fix the request before trying again.`, type, status, retryable: false };
}
