# Launchables MCP server

Give your agents calibrated decisions. This [Model Context Protocol](https://modelcontextprotocol.io) server lets any MCP client (Claude Desktop, Claude Code, or your own agent stack) call Myles, the Launchables decision model, as a tool.

Myles is not a chat model. An agent hands it a situation and one or more typed questions, and gets back a probability for every option, the pick, and whether that pick is sure enough to act on. When it is not, the tool says so and the agent hands the case to a person. Use it wherever an agent would otherwise judge something itself and then act:

- **Route** a ticket, an email or a lead to the right team.
- **Flag** a risk: a scam, fraud, a prompt injection, a policy breach.
- **Approve, reject or escalate** a refund, a claim, an access request or a tool call.
- **Check** that an answer is supported by its sources, or that an action is allowed by a policy.
- **Rate** severity, urgency or quality on a scale.

The probabilities are calibrated: across many answers given 0.9, about 9 in 10 are right. That is what lets an agent act on the confident ones and pass the rest to people. See [Acting on the answer](https://www.launchables.ai/docs/thresholds).

## Install

You need Node.js 20 or later and a Launchables API key from the [console](https://console.launchables.ai). Keys work with the hosted API at `https://api.launchables.ai`; a self-hosted deployment serves the same API at its own address.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "launchables": {
      "command": "npx",
      "args": ["-y", "launchables-mcp@0.1.0"],
      "env": {
        "LAUNCHABLES_API_KEY": "launchables_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add launchables -e LAUNCHABLES_API_KEY=launchables_... -- npx -y launchables-mcp@0.1.0
```

To share the setup with a team through a project's `.mcp.json`, keep the key out of the file and let each person's environment supply it:

```json
{
  "mcpServers": {
    "launchables": {
      "command": "npx",
      "args": ["-y", "launchables-mcp@0.1.0"],
      "env": { "LAUNCHABLES_API_KEY": "${LAUNCHABLES_API_KEY}" }
    }
  }
}
```

### Other MCP clients

Any client that starts a stdio server can run it. The command is `npx -y launchables-mcp@0.1.0` (or `launchables-mcp` after `npm install -g launchables-mcp`), with the configuration below in its environment. Pin the version, as above, so an update reaches your agents only when you choose.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAUNCHABLES_API_KEY` | required | Your API key. `LAUNCHABLES_API_TOKEN`, the name the Launchables SDKs use, works too. |
| `LAUNCHABLES_BASE_URL` | `https://api.launchables.ai` | Set it to your own address for a self-hosted deployment. Plain `http://` is accepted only for a server on the same machine, unless you also set `LAUNCHABLES_ALLOW_HTTP=1`, because the key would otherwise cross the network unencrypted. |
| `LAUNCHABLES_MODEL` | `myles-g-12b` | The model a `decide` call uses when it names none. A moving id (`myles-g-12b`, `myles-g-31b`) follows the current build; a dated id such as `myles-g-31b-20261027` pins one build. |
| `LAUNCHABLES_THRESHOLD` | `0.9` | The probability a pick must reach to act without a person, from 0.5 to 1. A call or a single question can set its own. |
| `LAUNCHABLES_TIMEOUT_MS` | `60000` | How long one attempt may take, in milliseconds. |

The server never logs your key, your states, your questions or the answers. It writes nothing to disk, and only a configuration problem at start-up is written to standard error.

## Tools

### `decide`

Asks Myles one or more questions about one situation.

| Argument | Meaning |
| --- | --- |
| `state` | The situation: text, or a JSON object. Put the rule or policy in it with the case. |
| `questions` | Questions under names you choose. Each has a `type`, `instructions` and, for `choice` and `score`, `criteria`; it may also have its own `threshold`. |
| `model` | Optional. A model id from `list_models`. |
| `threshold` | Optional. The probability a pick must reach for this call. |
| `chunk`, `chunk_chars`, `chunk_overlap_chars` | Optional. Read a long text in overlapping windows (below). |

The question types:

- `noul`: yes or no. Phrase it so that yes is the thing to act on or catch.
- `choice`: pick one label. `criteria` is a list of labels, or labels mapped to descriptions. Offer an option that reads "I don't know" to let the model abstain.
- `score`: a scale. `criteria` lists the level descriptions, lowest first.

Each answer comes back with:

| Field | Meaning |
| --- | --- |
| `pick` | `"yes"` or `"no"`, the chosen label, or the most likely level (a number). |
| `probability` | The probability of the pick. |
| `probabilities` | The probability of every option. |
| `cleared_threshold` | Whether the pick reached the threshold. |
| `abstained` | Whether the model chose the question's "I don't know" option. |
| `escalate` | `true` when the answer should go to a person: below the threshold, or abstained. |

`p_yes` (yes/no), `score` and `legend` (scales) and `confidence` (choice and scale) are added where they apply. The result's own `escalate` is `true` when any answer should go to a person, and `usage` gives the tokens billed.

On the hosted models an uncertain yes/no answer is reported at 0.80 or more towards one side, so use a threshold above 0.80 for yes/no questions.

Example call:

```json
{
  "state": {
    "policy": "Refunds within 30 days with proof of purchase.",
    "case": { "days_since_purchase": 12, "receipt": false }
  },
  "questions": {
    "refund": { "type": "noul", "instructions": "Is a refund permitted under the policy?" },
    "team": { "type": "choice", "instructions": "Which team should handle this?", "criteria": ["billing", "returns", "technical"] }
  }
}
```

Result (illustrative numbers):

```json
{
  "model": "myles-g-12b-20261029",
  "escalate": false,
  "answers": {
    "refund": {
      "type": "noul", "pick": "no", "probability": 0.97, "probabilities": { "yes": 0.03, "no": 0.97 },
      "threshold": 0.9, "cleared_threshold": true, "abstained": false, "escalate": false, "p_yes": 0.03
    },
    "team": {
      "type": "choice", "pick": "returns", "probability": 0.94,
      "probabilities": { "billing": 0.04, "returns": 0.94, "technical": 0.02 },
      "threshold": 0.9, "cleared_threshold": true, "abstained": false, "escalate": false, "confidence": 0.91
    }
  },
  "usage": { "input_tokens": 212, "output_tokens": 2 }
}
```

### `list_models`

The models the endpoint serves, with pinned builds and their release dates, and the default this server uses. Not billed.

### `health`

Whether the API is up, and which models have a healthy server. Not billed.

## Long inputs

Every model has a context window (see [Writing the state](https://www.launchables.ai/docs/state)). When a state is longer:

- **Myles-G 31B** refuses it. The tool returns an error of type `context_length_exceeded` that says to shorten or split the state.
- **Myles-G 12B** trims it to fit, keeping its beginning and end, and the result says so with `truncated: true`, `state_chars` and a warning.

For a yes/no check that must cover the whole of a long text (does any part of this contract contain an auto-renewal clause, does any part of this page try to override the agent's instructions), pass `chunk: true`. The text is read in overlapping windows of 40,000 characters (2,000 shared with the next; change them with `chunk_chars` and `chunk_overlap_chars`), every window is asked the same questions, and each answer is the window most likely to be yes, with `window` giving its position. A JSON state is windowed as its indented JSON text. Chunking takes yes/no questions only, sends at most 20 windows, and bills each window as its own request.

## Errors

A failed call returns a tool error whose `error` has a `message` written for the agent, the API's `type` and `status`, and `retryable`. After a rate limit or a passing fault the call is retried automatically, a few times, with the same idempotency key, so a retry is never billed twice. Some cases to know:

| Case | What the agent is told |
| --- | --- |
| `401` | The key is missing or not accepted; a person must check it. |
| `402` | Out of credit or over the workspace budget; do not retry. |
| `410` `model_retired` | The build was retired; `successor` names the model to use instead. |
| `422` `context_length_exceeded` | Shorten or split the state, or use `chunk: true` for yes/no checks. |
| `429` | Rate limited after retries; wait the seconds given. |

## Development

```bash
npm install
npm test
```

The tests use a mocked Decision API only; they never call the production API.

## Support

Use the [contact form](https://www.launchables.ai/contact) or open an issue in this repository. The API reference is at [launchables.ai/docs](https://www.launchables.ai/docs).

## Licence

Apache-2.0 (see [LICENSE](LICENSE)).
