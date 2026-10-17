/** Shapes shared by the question bank, the exam loop and the saved result file. */

export const DOMAINS = [
  "Applications and Integration",
  "Model Selection and Optimization",
  "Agents and Workflows",
  "Prompt and Context Engineering",
  "Tools and MCPs",
  "Security and Safety",
  "Claude Code",
  "Eval, Testing, and Debugging",
] as const;

export type Domain = (typeof DOMAINS)[number];

/** `multi` questions require every correct option and nothing else to be selected. */
export type QuestionType = "single" | "multi";

export interface Option {
  key: string;
  text: string;
}

export interface Question {
  id: string;
  domain: Domain;
  type: QuestionType;
  question: string;
  options: Option[];
  correct: string[];
  explanation: string;
  reference?: string;
}

export interface QuestionBank {
  exam: string;
  examCode: string;
  passingScorePercent: number;
  questions: Question[];
}

export interface AnsweredQuestion {
  number: number;
  id: string;
  domain: Domain;
  type: QuestionType;
  question: string;
  options: Option[];
  yourAnswer: string[];
  correctAnswer: string[];
  status: "correct" | "incorrect" | "skipped";
  explanation: string;
  reference?: string;
  secondsSpent: number;
}

export interface DomainScore {
  domain: Domain;
  asked: number;
  correct: number;
  percent: number;
}

export interface ExamResult {
  exam: string;
  examCode: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  sittings: number;
  completed: boolean;
  questionsAsked: number;
  questionsInExam: number;
  correct: number;
  incorrect: number;
  skipped: number;
  scorePercent: number;
  scaledScore: number;
  passingScorePercent: number;
  passed: boolean;
  domainBreakdown: DomainScore[];
  missedQuestionIds: string[];
  answers: AnsweredQuestion[];
}
