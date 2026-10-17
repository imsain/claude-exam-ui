/** Grading rules shared by the terminal exam loop and the web server. */
import type { AnsweredQuestion, Question } from "./types.ts";

/** Multi-answer questions need every correct key and nothing else. */
export function isCorrectAnswer(question: Question, response: readonly string[]): boolean {
  return (
    response.length === question.correct.length &&
    response.every((key) => question.correct.includes(key))
  );
}

/** An empty response means the question was skipped, which scores as incorrect. */
export function answerStatus(
  question: Question,
  response: readonly string[],
): AnsweredQuestion["status"] {
  if (response.length === 0) return "skipped";
  return isCorrectAnswer(question, response) ? "correct" : "incorrect";
}

export function recordAnswer(
  question: Question,
  number: number,
  response: readonly string[],
  secondsSpent: number,
): AnsweredQuestion {
  return {
    number,
    id: question.id,
    domain: question.domain,
    type: question.type,
    question: question.question,
    options: question.options,
    yourAnswer: [...response],
    correctAnswer: question.correct,
    status: answerStatus(question, response),
    explanation: question.explanation,
    reference: question.reference,
    secondsSpent,
  };
}
