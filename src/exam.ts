import type { AnsweredQuestion, Question, QuestionBank } from "./types.ts";
import { isCorrectAnswer, recordAnswer } from "./grade.ts";
import { Prompt, parseAnswer } from "./prompt.ts";
import {
  CHECK,
  CROSS,
  blue,
  bold,
  dim,
  green,
  heading,
  magenta,
  progressBar,
  red,
  rule,
  wrapText,
  yellow,
} from "./ui.ts";

const NUMBER_WORD = ["zero", "one", "TWO", "THREE", "FOUR", "FIVE"] as const;

export interface ResumeState {
  answers: readonly AnsweredQuestion[];
  elapsedSeconds: number;
  startedAt: Date;
}

export interface ExamOptions {
  reviewPause: boolean;
  resumeFrom?: ResumeState;
  /** Called after every answered question so progress can be persisted. */
  onProgress?: (progress: { answers: readonly AnsweredQuestion[]; elapsedSeconds: number }) => Promise<void>;
}

export interface ExamRun {
  answers: AnsweredQuestion[];
  completed: boolean;
  startedAt: Date;
  finishedAt: Date;
  elapsedSeconds: number;
}

export async function runExam(
  bank: QuestionBank,
  questions: readonly Question[],
  prompt: Prompt,
  options: ExamOptions,
): Promise<ExamRun> {
  const resume = options.resumeFrom;
  const answers: AnsweredQuestion[] = [...(resume?.answers ?? [])];
  const startedAt = resume?.startedAt ?? new Date();
  const previousSeconds = resume?.elapsedSeconds ?? 0;
  const sittingStarted = Date.now();
  const elapsedSeconds = () => previousSeconds + Math.round((Date.now() - sittingStarted) / 1000);

  let score = answers.filter((answer) => answer.status === "correct").length;
  let completed = true;

  if (answers.length > 0) {
    printResumeBanner(bank, questions.length, answers.length, score);
  } else {
    printIntro(bank, questions.length);
  }

  for (let index = answers.length; index < questions.length; index++) {
    const question = questions[index] as Question;
    const number = index + 1;
    printQuestion(question, number, questions.length, score, answers.length);

    const askedAt = Date.now();
    const response = await readResponse(question, prompt);
    const secondsSpent = Math.round((Date.now() - askedAt) / 1000);

    if (response === null) {
      completed = false;
      break;
    }

    const isCorrect = isCorrectAnswer(question, response);
    if (isCorrect) score += 1;

    answers.push(recordAnswer(question, number, response, secondsSpent));

    printFeedback(question, response, isCorrect, score, answers.length);
    await options.onProgress?.({ answers, elapsedSeconds: elapsedSeconds() });

    const isLast = number === questions.length;
    if (options.reviewPause && !isLast) {
      await prompt.pause(dim("Press Enter for the next question... "));
    }
  }

  return { answers, completed, startedAt, finishedAt: new Date(), elapsedSeconds: elapsedSeconds() };
}

/** Returns the selected keys, `[]` for a skip, or `null` to end the exam. */
async function readResponse(question: Question, prompt: Prompt): Promise<string[] | null> {
  const optionKeys = question.options.map((option) => option.key);
  const expected = question.correct.length;

  for (;;) {
    const label = expected === 1 ? "Your answer" : `Your answer (${expected} letters)`;
    const input = await prompt.ask(`${bold(label)} ${dim("[s = skip, q = quit]")}: `);
    if (input === null) return null;

    const parsed = parseAnswer(input, optionKeys, expected);
    switch (parsed.kind) {
      case "answer":
        return parsed.keys;
      case "skip":
        return [];
      case "quit":
        return null;
      case "invalid":
        console.log(yellow(`  ${parsed.reason} Try again.`));
    }
  }
}

function printIntro(bank: QuestionBank, total: number): void {
  console.log(heading(`  ${bank.exam}`));
  console.log(
    `  ${dim("Exam code:")} ${bank.examCode}    ${dim("Questions:")} ${total}    ` +
      `${dim("Pass mark:")} ${bank.passingScorePercent}%`,
  );
  console.log(
    dim(
      "\n  Answer with the option letter (or its number). Multi-answer questions\n" +
        "  take several letters at once, e.g. \"AC\" or \"a c\". Enter s to skip a\n" +
        "  question or q to stop early — your results are saved either way.",
    ),
  );
  console.log(rule());
}

function printResumeBanner(
  bank: QuestionBank,
  total: number,
  answered: number,
  score: number,
): void {
  console.log(heading(`  ${bank.exam} — resuming`));
  console.log(
    `  ${dim("Picking up at question")} ${bold(String(answered + 1))} ${dim(`of ${total}`)}    ` +
      `${dim("Score so far:")} ${formatRunningScore(score, answered)}`,
  );
  console.log(dim("\n  Enter s to skip a question or q to stop again — progress is saved as you go."));
  console.log(rule());
}

function printQuestion(
  question: Question,
  number: number,
  total: number,
  score: number,
  answered: number,
): void {
  const running = answered === 0 ? dim("score --") : formatRunningScore(score, answered);

  console.log("");
  console.log(
    `${bold(blue(`Question ${number}/${total}`))}  ${progressBar((number - 1) / total)}  ${running}`,
  );
  console.log(`${dim(`${question.domain} \u00b7 ${question.id}`)}`);
  console.log("");
  console.log(wrapText(question.question));

  if (question.type === "multi" && !/choose\s/i.test(question.question)) {
    const word = NUMBER_WORD[question.correct.length] ?? String(question.correct.length);
    console.log(magenta(`(Choose ${word}.)`));
  }

  console.log("");
  for (const option of question.options) {
    console.log(`  ${bold(option.key)}. ${wrapText(option.text, 5)}`);
  }
  console.log("");
}

function printFeedback(
  question: Question,
  response: readonly string[],
  isCorrect: boolean,
  score: number,
  answered: number,
): void {
  const correctText = question.correct
    .map((key) => `${key}. ${question.options.find((option) => option.key === key)?.text ?? ""}`)
    .join("  |  ");

  console.log("");
  if (response.length === 0) {
    console.log(yellow(`${CROSS} Skipped.`));
  } else if (isCorrect) {
    console.log(green(`${CHECK} Correct!`));
  } else {
    console.log(red(`${CROSS} Incorrect — you chose ${response.join(", ")}.`));
  }

  console.log(`${bold("Answer:")} ${green(wrapText(correctText, 8))}`);
  console.log(`${bold("Why:")} ${wrapText(question.explanation, 5)}`);
  if (question.reference) console.log(dim(`Docs: ${question.reference}`));

  console.log(`${dim("Running score:")} ${formatRunningScore(score, answered)}`);
  console.log(rule());
}

function formatRunningScore(score: number, answered: number): string {
  const percent = Math.round((score / answered) * 100);
  const text = `${score}/${answered} (${percent}%)`;
  if (percent >= 80) return green(text);
  if (percent >= 72) return yellow(text);
  return red(text);
}
