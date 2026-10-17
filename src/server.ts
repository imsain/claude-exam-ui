#!/usr/bin/env node
/**
 * Serves the browser front end and a small JSON API over the same exam engine the
 * CLI uses. Progress goes to the same `.exam-session.json` and finished sittings to
 * the same `results/` folder, so an exam can be started in one and finished in the other.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { BANK_PATH, PROJECT_ROOT, loadBank, selectQuestions } from "./bank.ts";
import { isCorrectAnswer, recordAnswer } from "./grade.ts";
import { parseAnswer } from "./prompt.ts";
import { buildResult, saveResult, timestampedResultPath } from "./report.ts";
import {
  SESSION_VERSION,
  type SavedSession,
  clearSession,
  defaultSessionPath,
  loadSession,
  quarantineSession,
  questionsRemaining,
  saveSession,
} from "./session.ts";
import { DOMAINS, type Domain, type ExamResult, type Question, type QuestionBank } from "./types.ts";
import { bold, dim, green, red, yellow } from "./ui.ts";

const WEB_ROOT = join(PROJECT_ROOT, "web");
const SESSION_PATH = defaultSessionPath(PROJECT_ROOT);
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The sitting currently open in the browser. Timing lives here; answers live on disk. */
interface Live {
  session: SavedSession;
  /** Seconds already banked by earlier sittings. */
  baseElapsed: number;
  sittingStartedAt: number;
  /** When the question on screen was handed out, for `secondsSpent`. */
  askedAt: number | null;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let bank: QuestionBank;
let live: Live | null = null;

function elapsedOf(state: Live): number {
  return state.baseElapsed + Math.round((Date.now() - state.sittingStartedAt) / 1000);
}

function currentQuestion(state: Live): Question | null {
  return state.session.questions[state.session.answers.length] ?? null;
}

function correctCount(state: Live): number {
  return state.session.answers.filter((answer) => answer.status === "correct").length;
}

function progressOf(state: Live) {
  const answered = state.session.answers.length;
  return {
    answered,
    total: state.session.questions.length,
    correct: correctCount(state),
    percent: answered === 0 ? null : Math.round((correctCount(state) / answered) * 100),
    elapsedSeconds: elapsedOf(state),
    sittings: state.session.sittings,
  };
}

/** The question as the browser may see it — without the answer key or explanation. */
function questionPayload(state: Live) {
  const question = currentQuestion(state);
  if (question === null) return null;

  state.askedAt = Date.now();
  return {
    number: state.session.answers.length + 1,
    total: state.session.questions.length,
    id: question.id,
    domain: question.domain,
    type: question.type,
    question: question.question,
    options: question.options,
    expected: question.correct.length,
  };
}

function examView(state: Live) {
  return { progress: progressOf(state), question: questionPayload(state), done: currentQuestion(state) === null };
}

function bankMeta() {
  return {
    exam: bank.exam,
    examCode: bank.examCode,
    passingScorePercent: bank.passingScorePercent,
    totalQuestions: bank.questions.length,
    domains: DOMAINS.map((domain) => ({
      name: domain,
      count: bank.questions.filter((question) => question.domain === domain).length,
    })).filter((entry) => entry.count > 0),
  };
}

async function readSavedSession(): Promise<SavedSession | null> {
  const lookup = await loadSession(SESSION_PATH);

  if (lookup.status === "invalid") {
    const movedTo = await quarantineSession(SESSION_PATH);
    console.log(
      yellow(
        `Saved progress could not be read (${lookup.reason})` +
          `${movedTo ? `, so it was moved to ${movedTo}` : ""}.`,
      ),
    );
    return null;
  }
  if (lookup.status === "none") return null;

  if (questionsRemaining(lookup.session) === 0) {
    await clearSession(SESSION_PATH);
    return null;
  }
  return lookup.session;
}

function newSession(questions: Question[]): SavedSession {
  const now = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    exam: bank.exam,
    examCode: bank.examCode,
    savedAt: now,
    startedAt: now,
    elapsedSeconds: 0,
    sittings: 1,
    bankPath: BANK_PATH,
    outPath: null,
    questions,
    answers: [],
  };
}

async function persist(state: Live): Promise<void> {
  state.session.savedAt = new Date().toISOString();
  state.session.elapsedSeconds = elapsedOf(state);
  await saveSession(state.session, SESSION_PATH);
}

function resultOf(state: Live, completed: boolean): ExamResult {
  const { session } = state;
  return buildResult(
    bank,
    {
      answers: session.answers,
      completed,
      startedAt: new Date(session.startedAt),
      finishedAt: new Date(),
      elapsedSeconds: elapsedOf(state),
    },
    { questionsInExam: session.questions.length, sittings: session.sittings },
  );
}

function requireLive(): Live {
  if (live === null) throw new HttpError(409, "No exam is in progress.");
  return live;
}

function asDomain(value: unknown): Domain | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const wanted = String(value).toLowerCase();
  const match = DOMAINS.find((domain) => domain.toLowerCase() === wanted);
  if (!match) throw new HttpError(400, `Unknown domain "${String(value)}".`);
  return match;
}

function asCount(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "Number of questions must be a positive whole number.");
  }
  return parsed;
}

function asSeed(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new HttpError(400, "Seed must be a whole number.");
  return parsed;
}

type Body = Record<string, unknown>;

const routes: Record<string, (body: Body) => Promise<unknown>> = {
  /** Everything the start screen needs: bank facts, the open sitting, and resumable progress. */
  "GET /api/state": async () => {
    const saved = live === null ? await readSavedSession() : null;
    return {
      ...bankMeta(),
      active: live === null ? null : examView(live),
      saved:
        saved === null
          ? null
          : {
              answered: saved.answers.length,
              total: saved.questions.length,
              correct: saved.answers.filter((answer) => answer.status === "correct").length,
              savedAt: saved.savedAt,
              sittings: saved.sittings,
            },
    };
  },

  "POST /api/exam": async (body) => {
    const count = asCount(body["count"], bank.questions.length);
    const domain = asDomain(body["domain"]);
    const questions = selectQuestions(bank, {
      count,
      domain,
      seed: asSeed(body["seed"]),
      shuffleQuestions: body["shuffleQuestions"] !== false,
      shuffleOptions: body["shuffleOptions"] !== false,
    });

    await clearSession(SESSION_PATH);
    live = { session: newSession(questions), baseElapsed: 0, sittingStartedAt: Date.now(), askedAt: null };
    await persist(live);

    const notice =
      questions.length < count
        ? `Only ${questions.length} question${questions.length === 1 ? "" : "s"} available` +
          `${domain ? ` in ${domain}` : ""} — running with those.`
        : null;

    return { ...examView(live), notice };
  },

  "POST /api/resume": async () => {
    const saved = await readSavedSession();
    if (saved === null) throw new HttpError(404, "There is no saved progress to continue.");

    saved.sittings += 1;
    live = {
      session: saved,
      baseElapsed: saved.elapsedSeconds,
      sittingStartedAt: Date.now(),
      askedAt: null,
    };
    return { ...examView(live), resumedAt: saved.answers.length + 1 };
  },

  "POST /api/discard": async () => {
    await clearSession(SESSION_PATH);
    live = null;
    return { discarded: true };
  },

  "GET /api/question": async () => examView(requireLive()),

  /** Grades one answer, saves progress, and reveals the explanation. */
  "POST /api/answer": async (body) => {
    const state = requireLive();
    const question = currentQuestion(state);
    if (question === null) throw new HttpError(409, "Every question has already been answered.");

    const response = readResponse(body, question);
    if (response === "quit") return { quit: true, result: await finishSitting(state, false) };

    const secondsSpent =
      state.askedAt === null ? 0 : Math.max(0, Math.round((Date.now() - state.askedAt) / 1000));
    const number = state.session.answers.length + 1;
    state.session.answers.push(recordAnswer(question, number, response, secondsSpent));
    state.askedAt = null;

    const completed = state.session.answers.length === state.session.questions.length;
    const feedback = {
      status: response.length === 0 ? "skipped" : isCorrectAnswer(question, response) ? "correct" : "incorrect",
      yourAnswer: response,
      correctAnswer: question.correct,
      correctOptions: question.options.filter((option) => question.correct.includes(option.key)),
      explanation: question.explanation,
      reference: question.reference ?? null,
      secondsSpent,
    };

    if (completed) {
      return { feedback, progress: progressOf(state), done: true, result: await finishSitting(state, true) };
    }

    await persist(state);
    return { feedback, progress: progressOf(state), done: false };
  },

  "POST /api/quit": async () => {
    const state = requireLive();
    return { result: await finishSitting(state, false) };
  },
};

/** Accepts checkbox keys, a typed answer like `ac`, or an explicit skip/quit. */
function readResponse(body: Body, question: Question): string[] | "quit" {
  if (body["quit"] === true) return "quit";
  if (body["skip"] === true) return [];

  const optionKeys = question.options.map((option) => option.key);
  const expected = question.correct.length;

  if (typeof body["input"] === "string") {
    const parsed = parseAnswer(body["input"], optionKeys, expected);
    if (parsed.kind === "quit") return "quit";
    if (parsed.kind === "skip") return [];
    if (parsed.kind === "invalid") throw new HttpError(400, parsed.reason);
    return parsed.keys;
  }

  const raw = body["keys"];
  if (!Array.isArray(raw)) throw new HttpError(400, "Pick an answer to continue.");

  const keys: string[] = [];
  for (const entry of raw) {
    const key = String(entry).toUpperCase();
    if (!optionKeys.includes(key)) throw new HttpError(400, `"${String(entry)}" is not one of ${optionKeys.join(", ")}.`);
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return [];
  if (keys.length !== expected) {
    throw new HttpError(
      400,
      expected === 1
        ? "This question takes a single answer."
        : `This question needs exactly ${expected} answers — you gave ${keys.length}.`,
    );
  }
  return keys.sort();
}

/**
 * Ends the sitting. A finished exam clears the session and writes the results JSON,
 * exactly like the CLI; an unfinished one leaves the session in place to resume.
 */
async function finishSitting(state: Live, completed: boolean): Promise<ExamResult & { savedTo: string | null }> {
  const result = resultOf(state, completed);

  if (completed) {
    await clearSession(SESSION_PATH);
    const path = state.session.outPath ?? timestampedResultPath(PROJECT_ROOT);
    await saveResult(result, path);
    live = null;
    console.log(
      `  ${result.passed ? green("PASS") : red("FAIL")} ${result.scorePercent}% ` +
        `${dim(`(scaled ${result.scaledScore})`)} ${dim("\u2192")} ${path}`,
    );
    return { ...result, savedTo: path };
  }

  await persist(state);
  live = null;
  console.log(dim(`  Progress saved at question ${result.questionsAsked}/${result.questionsInExam}.`));
  return { ...result, savedTo: null };
}

async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Body) : {};
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const isData = pathname.startsWith("/data");
  const root = isData ? join(WEB_ROOT, "data") : WEB_ROOT;
  const prefix = isData ? "/data" : "";
  const relative =
    pathname === "/" || pathname === prefix || pathname === `${prefix}/`
      ? "index.html"
      : pathname.slice(prefix.length).replace(/^\/+/, "");
  const target = join(root, normalize(relative));

  // normalize() collapses "..", so anything outside the mounted root is a traversal attempt.
  if (!target.startsWith(root)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(target);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": file.length,
      "cache-control": "no-store",
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: `Not found: ${pathname}` });
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  if (!pathname.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(pathname, response);
    return;
  }

  const route = routes[`${method} ${pathname}`];
  if (route === undefined) {
    sendJson(response, 404, { error: `No such endpoint: ${method} ${pathname}` });
    return;
  }

  const body = method === "GET" ? {} : await readBody(request);
  sendJson(response, 200, await route(body));
}

function parsePort(argv: readonly string[]): number {
  const flag = argv.indexOf("--port");
  const raw = flag === -1 ? process.env["PORT"] : argv[flag + 1];
  if (raw === undefined || raw === "") return 5173;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${raw}"`);
  }
  return parsed;
}

const port = parsePort(process.argv.slice(2));
bank = await loadBank();

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) console.error(red(`  ${request.method} ${request.url} — ${message}`));
    if (!response.headersSent) sendJson(response, status, { error: message });
    else response.end();
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(red(`\nPort ${port} is already in use. Try: npm run web -- --port 5174\n`));
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(port, () => {
  console.log(`\n  ${bold(bank.exam)} ${dim(`(${bank.examCode})`)}`);
  console.log(`  ${dim("Open")} ${bold(green(`http://localhost:${port}`))}`);
  console.log(`  ${dim(`${bank.questions.length} questions \u00b7 pass mark ${bank.passingScorePercent}% \u00b7 Ctrl+C to stop`)}\n`);
});
