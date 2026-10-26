import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Domain, type DomainScore, type ExamResult, type QuestionBank } from "./types.ts";
import type { ExamRun } from "./exam.ts";
import { CHECK, CROSS, bold, dim, green, heading, progressBar, red, rule, wrapText, yellow } from "./ui.ts";

/** Anthropic reports these exams on a 100–1000 scale with 720 to pass. */
function toScaledScore(percent: number): number {
  return Math.round(100 + (percent / 100) * 900);
}

export interface ResultContext {
  questionsInExam: number;
  sittings: number;
}

export function buildResult(bank: QuestionBank, run: ExamRun, context: ResultContext): ExamResult {
  const { questionsInExam } = context;
  const { answers } = run;
  const correct = answers.filter((answer) => answer.status === "correct").length;
  const incorrect = answers.filter((answer) => answer.status === "incorrect").length;
  const skipped = answers.filter((answer) => answer.status === "skipped").length;

  // Unanswered questions count against you, exactly like the real exam.
  const denominator = run.completed ? questionsInExam : answers.length || 1;
  const scorePercent = Math.round((correct / denominator) * 1000) / 10;

  const domainBreakdown: DomainScore[] = bank.domains.map((domain) => {
    const inDomain = answers.filter((answer) => answer.domain === domain);
    const domainCorrect = inDomain.filter((answer) => answer.status === "correct").length;
    return {
      domain,
      asked: inDomain.length,
      correct: domainCorrect,
      percent: inDomain.length === 0 ? 0 : Math.round((domainCorrect / inDomain.length) * 1000) / 10,
    };
  }).filter((score) => score.asked > 0);

  return {
    exam: bank.exam,
    examCode: bank.examCode,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    durationSeconds: run.elapsedSeconds,
    sittings: context.sittings,
    completed: run.completed,
    questionsAsked: answers.length,
    questionsInExam,
    correct,
    incorrect,
    skipped,
    scorePercent,
    scaledScore: toScaledScore(scorePercent),
    passingScorePercent: bank.passingScorePercent,
    passed: run.completed && scorePercent >= bank.passingScorePercent,
    domainBreakdown,
    missedQuestionIds: answers
      .filter((answer) => answer.status !== "correct")
      .map((answer) => answer.id),
    answers,
  };
}

export async function saveResult(result: ExamResult, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export interface SummaryOutput {
  /** Path of the results JSON, or null when nothing was written yet. */
  savedTo: string | null;
  /** Shown when the exam can be continued later. */
  resumeHint?: string;
}

export function printSummary(result: ExamResult, output: SummaryOutput): void {
  console.log(heading(result.completed ? "  Exam summary" : "  Progress so far"));

  const verdict = result.passed
    ? green(bold(`${CHECK} PASS`))
    : result.completed
      ? red(bold(`${CROSS} FAIL`))
      : yellow(bold("INCOMPLETE"));

  console.log(
    `  ${verdict}   ${bold(`${result.scorePercent}%`)} ` +
      `${dim(`(${result.correct}/${result.completed ? result.questionsInExam : result.questionsAsked} correct)`)}`,
  );
  if (result.completed) {
    console.log(`  ${dim("Scaled score:")} ${result.scaledScore}/1000   ${dim("pass mark 720")}`);
  } else {
    console.log(
      `  ${dim("Answered:")} ${result.questionsAsked}/${result.questionsInExam}   ` +
        `${dim("Remaining:")} ${result.questionsInExam - result.questionsAsked}`,
    );
  }
  console.log(
    `  ${dim("Time:")} ${formatDuration(result.durationSeconds)}   ` +
      `${dim("Incorrect:")} ${result.incorrect}   ${dim("Skipped:")} ${result.skipped}` +
      (result.sittings > 1 ? `   ${dim("Sittings:")} ${result.sittings}` : ""),
  );

  console.log(`\n  ${bold("By domain")}`);
  const labelWidth = Math.max(...result.domainBreakdown.map((score) => score.domain.length));
  for (const score of result.domainBreakdown) {
    const bar = progressBar(score.percent / 100, 18);
    const tally = `${score.correct}/${score.asked}`.padStart(6);
    console.log(
      `  ${score.domain.padEnd(labelWidth)}  ${bar} ${String(score.percent).padStart(5)}% ${dim(tally)}`,
    );
  }

  const missed = result.answers.filter((answer) => answer.status !== "correct");
  if (missed.length > 0) {
    console.log(`\n  ${bold("Review these")}`);
    for (const answer of missed.slice(0, 15)) {
      console.log(
        `  ${red(String(answer.number).padStart(3))}. ${wrapText(truncate(answer.question, 68), 8)}` +
          `\n       ${dim(`${answer.id} \u00b7 correct: ${answer.correctAnswer.join(", ")}`)}`,
      );
    }
    if (missed.length > 15) console.log(dim(`  ...and ${missed.length - 15} more.`));
  }

  if (output.savedTo) {
    console.log(`\n  ${dim("Full results with explanations:")} ${bold(output.savedTo)}`);
  }
  if (output.resumeHint) {
    console.log(`\n  ${green(output.resumeHint)}`);
  }
  console.log(rule());
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

export function timestampedResultPath(root: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${root}/results/exam-${stamp}.json`;
}

export type { Domain };
