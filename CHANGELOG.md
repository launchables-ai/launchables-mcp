# Changelog

## 0.1.0

First release of the Launchables MCP server.

- `decide`: a state (text or JSON) and one or more yes/no, choice or score questions; each answer gives the pick, its probability, every option's probability, whether it cleared the threshold, whether the model abstained ("I don't know"), and an `escalate` flag for answers a person should see.
- Thresholds from `LAUNCHABLES_THRESHOLD` (default 0.9), per call or per question.
- `chunk: true` reads a long text in overlapping windows for yes/no questions and answers with the window most likely to be yes (at most 20 windows, each billed as its own request).
- Clear tool errors for a missing or refused key, no credit, a retired build (naming its successor), a state too long for the context window (suggesting chunking) and rate limits.
- `list_models` and `health`.
- Configuration from `LAUNCHABLES_API_KEY` (or `LAUNCHABLES_API_TOKEN`), `LAUNCHABLES_BASE_URL` for self-hosted deployments, `LAUNCHABLES_MODEL` (default `myles-g-12b`) and `LAUNCHABLES_TIMEOUT_MS`. Plain `http://` only to the same machine unless `LAUNCHABLES_ALLOW_HTTP=1`.
- Built on the `launchables` JavaScript SDK 0.7.0: retries with one idempotency key per call, so a retried decision is never billed twice.
