import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Domain, PracticeSet, Question, QuestionBank } from "./types.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(projectRoot, "web", "data");
export const BANK_PATH = join(DATA_DIR, "questions.json");
export const PROJECT_ROOT = projectRoot;

/** The practice sets listed in web/data/sets.json; the first one is the default. */
export async function loadSets(): Promise<PracticeSet[]> {
  return JSON.parse(await readFile(join(DATA_DIR, "sets.json"), "utf8")) as PracticeSet[];
}

export function bankPathOf(set: PracticeSet): string {
  return join(DATA_DIR, set.file);
}

export async function loadBank(path: string = BANK_PATH): Promise<QuestionBank> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read the question bank at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const bank = parsed as QuestionBank;
  const problems = validateBank(bank);
  if (problems.length > 0) {
    throw new Error(`Question bank is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return bank;
}

/** Returns a human readable list of problems; empty means the bank is usable. */
export function validateBank(bank: QuestionBank): string[] {
  const problems: string[] = [];

  if (!Array.isArray(bank?.questions) || bank.questions.length === 0) {
    return ["no questions found"];
  }

  if (!Array.isArray(bank.domains) || bank.domains.length === 0) problems.push("bank has no domains list");
  if (!Number.isInteger(bank.examItems) || bank.examItems < 1) problems.push("bank has no examItems count");
  const domains = bank.domains ?? [];

  const seenIds = new Set<string>();
  for (const [index, question] of bank.questions.entries()) {
    const label = question?.id ?? `question at index ${index}`;

    if (!question.id) problems.push(`${label}: missing id`);
    if (seenIds.has(question.id)) problems.push(`${label}: duplicate id`);
    seenIds.add(question.id);

    if (!domains.includes(question.domain)) {
      problems.push(`${label}: unknown domain "${question.domain}"`);
    }
    if (!question.question?.trim()) problems.push(`${label}: missing question text`);
    if (!question.explanation?.trim()) problems.push(`${label}: missing explanation`);
    if (!Array.isArray(question.options) || question.options.length < 2) {
      problems.push(`${label}: needs at least two options`);
      continue;
    }

    const keys = question.options.map((option) => option.key);
    if (new Set(keys).size !== keys.length) problems.push(`${label}: duplicate option keys`);

    if (!Array.isArray(question.correct) || question.correct.length === 0) {
      problems.push(`${label}: no correct answer`);
      continue;
    }
    for (const key of question.correct) {
      if (!keys.includes(key)) problems.push(`${label}: correct answer "${key}" is not an option`);
    }
    if (question.type === "single" && question.correct.length !== 1) {
      problems.push(`${label}: type "single" must have exactly one correct answer`);
    }
    if (question.type === "multi" && question.correct.length < 2) {
      problems.push(`${label}: type "multi" must have at least two correct answers`);
    }
  }

  return problems;
}

/** Mulberry32 — a tiny seedable PRNG so `--seed` reproduces the same paper. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export interface SelectOptions {
  count: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  domain?: Domain;
  seed?: number;
}

/**
 * Picks the questions for one sitting. When trimming the bank we sample
 * proportionally per domain so a shorter exam keeps the real weighting.
 */
export function selectQuestions(bank: QuestionBank, options: SelectOptions): Question[] {
  const random = createRandom(options.seed ?? (Math.random() * 2 ** 32) >>> 0);

  let pool = bank.questions;
  if (options.domain) pool = pool.filter((question) => question.domain === options.domain);
  if (pool.length === 0) throw new Error("No questions matched the requested domain.");

  const count = Math.min(options.count, pool.length);
  let selected: Question[];

  if (count === pool.length) {
    selected = options.shuffleQuestions ? shuffle(pool, random) : [...pool];
  } else if (options.shuffleQuestions) {
    selected = sampleByDomain(pool, count, random);
  } else {
    selected = pool.slice(0, count);
  }

  if (!options.shuffleOptions) return selected;
  return selected.map((question) => shuffleOptions(question, random));
}

function sampleByDomain(pool: readonly Question[], count: number, random: () => number): Question[] {
  const byDomain = new Map<Domain, Question[]>();
  for (const question of pool) {
    const bucket = byDomain.get(question.domain) ?? [];
    bucket.push(question);
    byDomain.set(question.domain, bucket);
  }

  const picked: Question[] = [];
  const leftovers: Question[] = [];

  for (const [, bucket] of byDomain) {
    const shuffled = shuffle(bucket, random);
    const share = Math.floor((bucket.length / pool.length) * count);
    picked.push(...shuffled.slice(0, share));
    leftovers.push(...shuffled.slice(share));
  }

  picked.push(...shuffle(leftovers, random).slice(0, count - picked.length));
  return shuffle(picked, random);
}

/** Re-letters the options after shuffling so keys stay A, B, C… top to bottom. */
function shuffleOptions(question: Question, random: () => number): Question {
  const letters = "ABCDEFGH";
  const shuffled = shuffle(question.options, random);
  const correct: string[] = [];

  const options = shuffled.map((option, index) => {
    const key = letters[index] as string;
    if (question.correct.includes(option.key)) correct.push(key);
    return { key, text: option.text };
  });

  return { ...question, options, correct: correct.sort() };
}
