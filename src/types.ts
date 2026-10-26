/** Shapes shared by the question bank, the exam loop and the saved result file. */

/** Domain names come from each bank's `domains` list, so every practice set can have its own. */
export type Domain = string;

/** One entry of web/data/sets.json: a practice set and the bank file that holds it. */
export interface PracticeSet {
  id: string;
  label: string;
  file: string;
}

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
  /** Items on the real exam; the default length of a full sitting. */
  examItems: number;
  /** Domains in blueprint order; every question's domain must be one of these. */
  domains: Domain[];
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
