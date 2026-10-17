#!/usr/bin/env node
import { BANK_PATH, PROJECT_ROOT, loadBank, selectQuestions } from "./bank.ts";
import { type ResumeState, runExam } from "./exam.ts";
import { Prompt } from "./prompt.ts";
import { buildResult, printSummary, saveResult, timestampedResultPath } from "./report.ts";
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
import { DOMAINS, type AnsweredQuestion, type Domain, type Question } from "./types.ts";
import { bold, dim, green, red, yellow } from "./ui.ts";

interface Cli {
  count: number;
  domain?: Domain;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  seed?: number;
  out?: string;
  bank: string;
  reviewPause: boolean;
  session: string;
  resume: "ask" | "always" | "never";
}

const DOMAIN_ALIASES: Record<string, Domain> = {
  apps: "Applications and Integration",
  api: "Applications and Integration",
  models: "Model Selection and Optimization",
  model: "Model Selection and Optimization",
  agents: "Agents and Workflows",
  prompt: "Prompt and Context Engineering",
  context: "Prompt and Context Engineering",
  tools: "Tools and MCPs",
  mcp: "Tools and MCPs",
  security: "Security and Safety",
  safety: "Security and Safety",
  code: "Claude Code",
  "claude-code": "Claude Code",
  eval: "Eval, Testing, and Debugging",
  debug: "Eval, Testing, and Debugging",
};

function parseArgs(argv: readonly string[]): Cli | "help" {
  const cli: Cli = {
    count: 53,
    shuffleQuestions: true,
    shuffleOptions: true,
    bank: BANK_PATH,
    reviewPause: true,
    session: defaultSessionPath(PROJECT_ROOT),
    resume: "ask",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };

    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "-n":
      case "--count": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--count must be a positive integer");
        cli.count = parsed;
        break;
      }
      case "-d":
      case "--domain": {
        const raw = value();
        const domain =
          DOMAIN_ALIASES[raw.toLowerCase()] ??
          DOMAINS.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
        if (!domain) {
          throw new Error(
            `Unknown domain "${raw}". Try one of: apps, models, agents, prompt, tools, security, code, eval`,
          );
        }
        cli.domain = domain;
        break;
      }
      case "--seed": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed)) throw new Error("--seed must be an integer");
        cli.seed = parsed;
        break;
      }
      case "--no-shuffle":
        cli.shuffleQuestions = false;
        cli.shuffleOptions = false;
        break;
      case "--no-shuffle-options":
        cli.shuffleOptions = false;
        break;
      case "--fast":
        cli.reviewPause = false;
        break;
      case "-r":
      case "--resume":
        cli.resume = "always";
        break;
      case "--new":
      case "--restart":
        cli.resume = "never";
        break;
      case "--session":
        cli.session = value();
        break;
      case "-o":
      case "--out":
        cli.out = value();
        break;
      case "--bank":
        cli.bank = value();
        break;
      default:
        throw new Error(`Unknown option "${arg}". Run with --help to see what is available.`);
    }
  }

  return cli;
}

function printHelp(): void {
  console.log(`
${bold("Claude Certified Developer - Foundations (CCDV-F) exam simulator")}

${bold("Usage")}
  npm start                     Run a full 53-question exam
  npm start -- [options]

${bold("Options")}
  -n, --count <n>          Number of questions to ask (default 53)
  -d, --domain <name>      Drill one domain: apps | models | agents | prompt |
                           tools | security | code | eval
      --seed <n>           Reproduce an exact question order
      --no-shuffle         Ask questions and options in bank order
      --no-shuffle-options Keep answer choices in bank order
      --fast               Do not wait for Enter between questions
  -r, --resume             Continue saved progress without asking
      --new                Start a new exam and discard saved progress
      --session <file>     Where progress is saved (default .exam-session.json)
  -o, --out <file>         Where to write the results JSON
                           (default results/exam-<timestamp>.json)
      --bank <file>        Use a different question bank
  -h, --help               Show this help

${bold("During the exam")}
  ${dim("b")} or ${dim("2")}    answer with a letter or its number
  ${dim("AC")} or ${dim("a c")} multi-answer questions take every letter at once
  ${dim("s")}          skip the question
  ${dim("q")}          stop and save your place (Ctrl+C does the same)

${bold("Picking up later")}
  Progress is saved after every answer, so quitting mid-exam is safe.
  The next run offers to continue where you stopped.
`);
}

async function main(): Promise<void> {
  let cli: Cli | "help";
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(red(`\n${(error as Error).message}\n`));
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (cli === "help") {
    printHelp();
    return;
  }

  const bank = await loadBank(cli.bank);
  const saved = await findResumableSession(cli);
  const prompt = new Prompt();

  try {
    let resumed: SavedSession | null = null;
    if (saved !== null && cli.resume !== "never") {
      const wanted = cli.resume === "always" || (await confirmResume(saved, prompt));
      if (wanted) resumed = saved;
    }
    if (saved !== null && resumed === null) {
      await clearSession(cli.session);
      console.log(dim("Saved progress discarded — starting a new exam.\n"));
    }

    const questions: Question[] = resumed?.questions ?? selectQuestions(bank, cli);
    const sittings = (resumed?.sittings ?? 0) + 1;
    const outPath = cli.out ?? resumed?.outPath ?? null;
    const startedAt = resumed ? new Date(resumed.startedAt) : new Date();

    if (resumed === null && questions.length < cli.count) {
      console.log(
        yellow(
          `\nOnly ${questions.length} question${questions.length === 1 ? "" : "s"} available` +
            `${cli.domain ? ` in ${cli.domain}` : ""} — running with those.`,
        ),
      );
    }

    const resumeFrom: ResumeState | undefined = resumed
      ? { answers: resumed.answers, elapsedSeconds: resumed.elapsedSeconds, startedAt }
      : undefined;

    const snapshot = (answers: readonly AnsweredQuestion[], elapsedSeconds: number): SavedSession => ({
      version: SESSION_VERSION,
      exam: bank.exam,
      examCode: bank.examCode,
      savedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      elapsedSeconds,
      sittings,
      bankPath: cli.bank,
      outPath,
      questions,
      answers: [...answers],
    });

    const run = await runExam(bank, questions, prompt, {
      reviewPause: cli.reviewPause,
      resumeFrom,
      onProgress: async ({ answers, elapsedSeconds }) => {
        if (answers.length < questions.length) {
          await saveSession(snapshot(answers, elapsedSeconds), cli.session);
        }
      },
    });

    if (run.answers.length === 0) {
      console.log(yellow("\nNothing was answered, so no progress was saved.\n"));
      return;
    }

    const result = buildResult(bank, run, { questionsInExam: questions.length, sittings });

    if (run.completed) {
      await clearSession(cli.session);
      const resultPath = outPath ?? timestampedResultPath(PROJECT_ROOT);
      await saveResult(result, resultPath);
      printSummary(result, { savedTo: resultPath });
      return;
    }

    await saveSession(snapshot(run.answers, run.elapsedSeconds), cli.session);
    if (cli.out) await saveResult(result, cli.out);
    printSummary(result, {
      savedTo: cli.out ?? null,
      resumeHint: `Progress saved. Run ${bold("npm start")} again to continue from question ${run.answers.length + 1}.`,
    });
  } finally {
    prompt.close();
  }
}

async function findResumableSession(cli: Cli): Promise<SavedSession | null> {
  const lookup = await loadSession(cli.session);

  if (lookup.status === "invalid") {
    const movedTo = await quarantineSession(cli.session);
    console.log(
      yellow(
        `Saved progress could not be read (${lookup.reason})` +
          `${movedTo ? `, so it was moved to ${movedTo}` : ""}. Starting a new exam.`,
      ),
    );
    return null;
  }
  if (lookup.status === "none") return null;

  if (questionsRemaining(lookup.session) === 0) {
    await clearSession(cli.session);
    return null;
  }

  return lookup.session;
}

async function confirmResume(session: SavedSession, prompt: Prompt): Promise<boolean> {
  const answered = session.answers.length;
  const total = session.questions.length;
  const correct = session.answers.filter((answer) => answer.status === "correct").length;

  console.log(`\n${bold("You have an exam in progress.")}`);
  console.log(
    `  ${dim("Answered:")} ${answered}/${total}    ${dim("Score:")} ${correct}/${answered}    ` +
      `${dim("Last saved:")} ${describeAge(session.savedAt)}`,
  );

  const reply = await prompt.ask(
    `${green("Continue where you left off?")} ${dim("[Y/n]")} `,
  );
  return reply === null || !/^n/i.test(reply.trim());
}

function describeAge(isoDate: string): string {
  const minutes = Math.round((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

main().catch((error: unknown) => {
  console.error(red(`\n${error instanceof Error ? error.message : String(error)}\n`));
  process.exitCode = 1;
});
