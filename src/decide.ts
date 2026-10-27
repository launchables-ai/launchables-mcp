import type { Answer, DecisionResponse, Launchables, Questions, Usage } from "launchables";
import { MIN_THRESHOLD } from "./config.js";
import { ToolInputError } from "./errors.js";

export interface QuestionInput {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: string[] | Record<string, string | null>;
  /** This question's own threshold, overriding the call's. */
  threshold?: number;
}

export interface DecideInput {
  state: string | Record<string, unknown>;
  questions: Record<string, QuestionInput>;
  model?: string;
  threshold?: number;
  chunk?: boolean;
  chunk_chars?: number;
  chunk_overlap_chars?: number;
}

export interface Defaults {
  model: string;
  threshold: number;
}

export interface AnswerOutput {
  type: "noul" | "choice" | "score";
  /** "yes" or "no" for a yes/no question, the label for a choice, the most likely level (a number) for a score. */
  pick: string | number;
  /** The probability of the pick. */
  probability: number;
  probabilities: Record<string, number>;
  threshold: number;
  /** Whether the pick's probability reached the threshold. */
  cleared_threshold: boolean;
  /** Whether the model chose the question's "I don't know" option. */
  abstained: boolean;
  /** True when this answer should go to a person: below the threshold, or the model abstained. */
  escalate: boolean;
  /** Yes/no only: the probability of yes. */
  p_yes?: number;
  /** Score only: the expected level (probability-weighted), and the level descriptions by number. */
  score?: number;
  legend?: Record<string, string>;
  /** Choice and score: the API's own confidence measure, when it sends one. */
  confidence?: number;
  /** Chunked yes/no only: the window that gave the highest probability of yes. */
  window?: { index: number; start: number; end: number };
}

export interface DecideOutput {
  model: string;
  /** True when any answer should go to a person. */
  escalate: boolean;
  answers: Record<string, AnswerOutput>;
  usage: Usage;
  truncated?: boolean;
  state_chars?: { original: number; kept: number };
  chunked?: { windows: number; chunk_chars: number; overlap_chars: number; state_chars: number };
  warnings?: string[];
}

export const DEFAULT_CHUNK_CHARS = 40_000;
export const DEFAULT_CHUNK_OVERLAP = 2_000;
export const MIN_CHUNK_CHARS = 2_000;
export const MAX_CHUNK_CHARS = 400_000;
/** The most windows one chunked call may send: each window is a billed request. */
export const MAX_WINDOWS = 20;
const WINDOW_CONCURRENCY = 4;

/** As the API recognises an abstain option: "I don't know" in any case, curly or straight apostrophe, a trailing full stop. */
const ABSTAIN_TEXTS = new Set(["i don't know", "i do not know", "i dont know"]);
function abstainKey(text: string): string {
  return text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[.!]+$/, "").trim();
}

function isAbstainOption(question: QuestionInput, label: string): boolean {
  if (question.type !== "choice") return false;
  if (ABSTAIN_TEXTS.has(abstainKey(label))) return true;
  const crit = question.criteria;
  if (crit && !Array.isArray(crit)) {
    const text = crit[label];
    if (typeof text === "string" && ABSTAIN_TEXTS.has(abstainKey(text))) return true;
  }
  return false;
}

function checkThreshold(t: number, where: string): number {
  if (!Number.isFinite(t) || t < MIN_THRESHOLD || t > 1) {
    throw new ToolInputError(`${where} must be from ${MIN_THRESHOLD} to 1, got ${t}`);
  }
  return t;
}

/** The questions as the API takes them: this server's own fields (threshold) removed. */
function apiQuestions(questions: Record<string, QuestionInput>): Questions {
  const out: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const sent: Record<string, unknown> = { type: q.type, instructions: q.instructions };
    if (q.criteria !== undefined) sent.criteria = q.criteria;
    out[name] = sent;
  }
  return out as Questions;
}

function round(p: number): number {
  return Math.round(p * 10_000) / 10_000;
}

function shapeNoul(pYes: number, threshold: number): AnswerOutput {
  const pick = pYes >= 0.5 ? "yes" : "no";
  const probability = pick === "yes" ? pYes : 1 - pYes;
  const cleared = probability >= threshold;
  return {
    type: "noul",
    pick,
    probability: round(probability),
    probabilities: { yes: round(pYes), no: round(1 - pYes) },
    threshold,
    cleared_threshold: cleared,
    abstained: false,
    escalate: !cleared,
    p_yes: round(pYes),
  };
}

/** One API answer shaped for an agent: the pick, its probability, the threshold check and the escalate flag. */
export function shapeAnswer(answer: Answer, question: QuestionInput, threshold: number): AnswerOutput {
  if (answer.type === "noul") return shapeNoul(answer.noul, threshold);
  const confidence = typeof answer.raw.confidence === "number" ? { confidence: answer.raw.confidence } : {};
  if (answer.type === "choice") {
    const probability = answer.probabilities[answer.choice] ?? 0;
    const abstained = isAbstainOption(question, answer.choice);
    const cleared = !abstained && probability >= threshold;
    return {
      type: "choice",
      pick: answer.choice,
      probability: round(probability),
      probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([k, p]) => [k, round(p)])),
      threshold,
      cleared_threshold: cleared,
      abstained,
      escalate: !cleared,
      ...confidence,
    };
  }
  const probability = answer.probabilities[String(answer.level)] ?? 0;
  const cleared = probability >= threshold;
  const legend = answer.raw.legend;
  return {
    type: "score",
    pick: answer.level,
    probability: round(probability),
    probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([k, p]) => [k, round(p)])),
    threshold,
    cleared_threshold: cleared,
    abstained: false,
    escalate: !cleared,
    score: round(answer.score),
    ...(legend && typeof legend === "object" ? { legend: legend as Record<string, string> } : {}),
    ...confidence,
  };
}

/** Overlapping windows over `text`: [start, end) pairs covering all of it, each at most `size` characters. */
export function windows(length: number, size: number, overlap: number): Array<[number, number]> {
  if (length <= size) return [[0, length]];
  const step = size - overlap;
  const out: Array<[number, number]> = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(start + size, length);
    out.push([start, end]);
    if (end >= length) return out;
  }
}

async function inPool<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false; // after one failure no new item is started, so nothing more is sent (or billed) for a lost call
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await run(items[i] as T, i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function thresholds(input: DecideInput, defaults: Defaults): Record<string, number> {
  const base = input.threshold === undefined ? defaults.threshold : checkThreshold(input.threshold, "threshold");
  const out: Record<string, number> = {};
  for (const [name, q] of Object.entries(input.questions)) {
    out[name] = q.threshold === undefined ? base : checkThreshold(q.threshold, `questions.${name}.threshold`);
  }
  return out;
}

function finish(out: DecideOutput, warnings: string[]): DecideOutput {
  out.escalate = Object.values(out.answers).some((a) => a.escalate);
  if (warnings.length > 0) out.warnings = warnings;
  return out;
}

/** Asks the Decision API and shapes the answers. With `chunk`, reads a long text in windows (yes/no questions only). */
export async function decide(client: Launchables, input: DecideInput, defaults: Defaults): Promise<DecideOutput> {
  const names = Object.keys(input.questions);
  if (names.length === 0) throw new ToolInputError("questions must hold at least one question");
  const limits = thresholds(input, defaults);
  const model = input.model ?? defaults.model;
  const questions = apiQuestions(input.questions);
  if (input.chunk) return decideChunked(client, input, questions, limits, model);
  if (input.chunk_chars !== undefined || input.chunk_overlap_chars !== undefined) {
    throw new ToolInputError("chunk_chars and chunk_overlap_chars apply only with chunk: true");
  }

  const res = await client.decide(input.state, questions, { model });
  const warnings: string[] = [];
  const out: DecideOutput = { model: res.model, escalate: false, answers: {}, usage: res.usage };
  for (const name of names) {
    const answer = res.answers[name];
    if (!answer) throw new ToolInputError(`the API returned no answer for question "${name}"`);
    out.answers[name] = shapeAnswer(answer, input.questions[name] as QuestionInput, limits[name] as number);
  }
  if (res.raw.truncated === true) {
    out.truncated = true;
    const chars = res.raw.state_chars as { original?: unknown; kept?: unknown } | undefined;
    if (chars && typeof chars.original === "number" && typeof chars.kept === "number") {
      out.state_chars = { original: chars.original, kept: chars.kept };
    }
    warnings.push(
      "The model did not read the whole state: it was trimmed to fit the context window (its beginning and end were kept). " +
        "For yes/no checks over a long text, call again with chunk: true; otherwise send only what the decision needs.",
    );
  }
  return finish(out, warnings);
}

async function decideChunked(
  client: Launchables,
  input: DecideInput,
  questions: Questions,
  limits: Record<string, number>,
  model: string,
): Promise<DecideOutput> {
  const notNoul = Object.entries(input.questions).filter(([, q]) => q.type !== "noul").map(([n]) => n);
  if (notNoul.length > 0) {
    throw new ToolInputError(
      `chunk works with yes/no (noul) questions only; ${notNoul.map((n) => `"${n}"`).join(", ")} ${notNoul.length === 1 ? "is" : "are"} not. ` +
        "Ask those without chunk, or about a shorter state.",
    );
  }
  const size = input.chunk_chars ?? DEFAULT_CHUNK_CHARS;
  // a smaller window than the default keeps a proportionate overlap unless one is given
  const overlap = input.chunk_overlap_chars ?? Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(size / 4));
  if (!Number.isInteger(size) || size < MIN_CHUNK_CHARS || size > MAX_CHUNK_CHARS) {
    throw new ToolInputError(`chunk_chars must be a whole number from ${MIN_CHUNK_CHARS} to ${MAX_CHUNK_CHARS}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > size / 2) {
    throw new ToolInputError("chunk_overlap_chars must be a whole number from 0 to half of chunk_chars");
  }
  // a JSON state is read as the API reads it: indented JSON text
  const text = typeof input.state === "string" ? input.state : JSON.stringify(input.state, null, 1);
  const spans = windows(text.length, size, overlap);
  if (spans.length > MAX_WINDOWS) {
    throw new ToolInputError(
      `the state would need ${spans.length} windows of ${size} characters; at most ${MAX_WINDOWS} are sent in one call. ` +
        "Raise chunk_chars, send a shorter state, or split the work over several calls.",
    );
  }

  const results: DecisionResponse[] = await inPool(spans, WINDOW_CONCURRENCY, ([start, end]) =>
    client.decide(text.slice(start, end), questions, { model }),
  );

  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const warnings: string[] = [];
  for (const res of results) {
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
  }
  if (results.some((r) => r.raw.truncated === true)) {
    warnings.push("At least one window was itself trimmed to fit the context window; use a smaller chunk_chars.");
  }
  const out: DecideOutput = {
    model: results[0]?.model ?? model,
    escalate: false,
    answers: {},
    usage,
    chunked: { windows: spans.length, chunk_chars: size, overlap_chars: overlap, state_chars: text.length },
  };
  for (const name of Object.keys(input.questions)) {
    let best = -1;
    let at = 0;
    results.forEach((res, i) => {
      const a = res.answers[name];
      if (a?.type !== "noul") throw new ToolInputError(`the API returned no yes/no answer for question "${name}"`);
      if (a.noul > best) {
        best = a.noul;
        at = i;
      }
    });
    const [start, end] = spans[at] as [number, number];
    out.answers[name] = { ...shapeNoul(best, limits[name] as number), window: { index: at, start, end } };
  }
  return finish(out, warnings);
}
