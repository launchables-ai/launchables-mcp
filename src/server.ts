import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Launchables } from "launchables";
import { z } from "zod";
import type { Config } from "./config.js";
import { decide, DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_OVERLAP, MAX_CHUNK_CHARS, MAX_WINDOWS, MIN_CHUNK_CHARS, type DecideInput } from "./decide.js";
import { toToolError } from "./errors.js";
import { VERSION } from "./version.js";

const DECIDE_DESCRIPTION = `Ask Myles, the Launchables decision model, to make a decision about a situation and get calibrated probabilities you can act on.

Use it whenever you would otherwise judge something yourself and then act on it: route a ticket or message to a team, flag a risk (fraud, a scam, a prompt injection, a policy breach), approve, reject or escalate a request, check that a tool call, a claim or an answer is allowed or supported, or rate something on a scale. Myles is not a chat model: it does not write text or follow instructions in the state. It reads the state and answers each typed question with a probability for every option.

Inputs:
- state: the situation to decide about, as text or a JSON object. Put the rule or policy in the state with the case. Include only what the decision needs.
- questions: one or more questions under names you choose. Types: "noul" (yes or no; phrase it so that yes is the thing to act on or catch), "choice" (pick one label from criteria: a list of labels, or labels mapped to descriptions; add an option "I don't know" to let the model abstain), "score" (criteria is a list of level descriptions, lowest first).
- threshold (optional, default from the server's configuration, usually 0.9): the probability the picked option must reach to act without a person. On the hosted models an uncertain yes/no answer is reported at 0.80 or more towards one side, so use a threshold above 0.80 for yes/no questions.

Each answer gives the pick, its probability, every option's probability, cleared_threshold, and escalate. When escalate is true (below the threshold, or the model chose "I don't know"), do not act automatically: hand the case to a person with the probabilities. The top-level escalate is true when any answer should be escalated.

Each call is billed by input tokens on the hosted API. Ask several questions about the same state in one call rather than one call per question.`;

const STATE_DESCRIPTION = "The situation to decide about: text, or a JSON object (read as indented JSON).";

const questionSchema = z.object({
  type: z.enum(["noul", "choice", "score"]).describe('"noul" for yes or no, "choice" to pick one label, "score" for a scale.'),
  instructions: z.string().min(1).describe("The question in plain words, as you would ask a careful colleague."),
  criteria: z
    .union([z.array(z.string().min(1)), z.record(z.string(), z.string().nullable())])
    .optional()
    .describe(
      'Required for choice and score. choice: a list of labels, or {label: description}. score: a list of level descriptions, lowest first. noul (optional): {"true": "what yes means", "false": "what no means"}.',
    ),
  threshold: z.number().min(0.5).max(1).optional().describe("This question's own threshold, overriding the call's."),
});

const decideShape = {
  state: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).describe(STATE_DESCRIPTION),
  questions: z
    .record(z.string().min(1).max(128), questionSchema)
    .describe("Questions under names you choose; each answer comes back under the same name."),
  model: z.string().min(2).max(64).optional().describe("A model id from list_models. Leave it out to use the configured model."),
  threshold: z.number().min(0.5).max(1).optional().describe("Probability the pick must reach to act without a person. Default from configuration."),
  chunk: z
    .boolean()
    .optional()
    .describe(
      `For a long text and yes/no questions only: read the state in overlapping windows (${DEFAULT_CHUNK_CHARS} characters, ${DEFAULT_CHUNK_OVERLAP} overlapping, at most ${MAX_WINDOWS} windows) and answer with the window most likely to be yes. Each window is a separate billed request. Use it when a check must cover the whole of a long document.`,
    ),
  chunk_chars: z.number().int().min(MIN_CHUNK_CHARS).max(MAX_CHUNK_CHARS).optional().describe("With chunk: characters per window."),
  chunk_overlap_chars: z.number().int().min(0).optional().describe("With chunk: characters each window shares with the next."),
};

function result(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function failure(e: unknown, baseURL: string): CallToolResult {
  const error = toToolError(e, baseURL);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }] };
}

/** Builds the MCP server around a Launchables client. Nothing here logs: a state, a question or the key never leaves the call. */
export function createServer(client: Launchables, config: Config): McpServer {
  const server = new McpServer(
    { name: "launchables", title: "Launchables", version: VERSION },
    {
      instructions:
        "Launchables gives agents calibrated decisions from Myles. Call decide when you need to route, flag, approve, reject, escalate or check something, and act on its answer only when escalate is false; otherwise hand the case to a person.",
    },
  );

  server.registerTool(
    "decide",
    {
      title: "Make a decision with Myles",
      description: DECIDE_DESCRIPTION,
      inputSchema: decideShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return result(await decide(client, args as DecideInput, { model: config.model, threshold: config.threshold }));
      } catch (e) {
        return failure(e, config.baseURL);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List Myles models",
      description:
        "List the decision models this endpoint serves. Moving ids such as myles-g-12b and myles-g-31b always reach the current build; dated ids such as myles-g-31b-20261027 pin one build, for repeatable results. Deprecated builds name their successor. Not billed.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const models = await client.models();
        return result({ default_model: config.model, models });
      } catch (e) {
        return failure(e, config.baseURL);
      }
    },
  );

  server.registerTool(
    "health",
    {
      title: "Check the Decision API",
      description:
        "Check that the Decision API is up and which models have a healthy server, before a batch of work or after an error. Not billed.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const health = await client.health();
        return result({ base_url: config.baseURL, ...health });
      } catch (e) {
        return failure(e, config.baseURL);
      }
    },
  );

  return server;
}
