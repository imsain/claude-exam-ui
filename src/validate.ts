#!/usr/bin/env node
/** Sanity-checks web/data/questions.json and prints the domain weighting. */
import { readFile } from "node:fs/promises";
import { BANK_PATH, validateBank } from "./bank.ts";
import { DOMAINS, type QuestionBank } from "./types.ts";
import { CHECK, CROSS, bold, dim, green, red } from "./ui.ts";

const path = process.argv[2] ?? BANK_PATH;
const bank = JSON.parse(await readFile(path, "utf8")) as QuestionBank;
const problems = validateBank(bank);

if (problems.length > 0) {
  console.error(red(`${CROSS} ${problems.length} problem(s) in ${path}`));
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(green(`${CHECK} ${bank.questions.length} questions look good`));
console.log(`${bold("Domain weighting")} ${dim(`(${bank.examCode})`)}`);

for (const domain of DOMAINS) {
  const inDomain = bank.questions.filter((question) => question.domain === domain);
  const share = ((inDomain.length / bank.questions.length) * 100).toFixed(0);
  console.log(`  ${domain.padEnd(34)} ${String(inDomain.length).padStart(3)}  ${dim(`${share}%`)}`);
}

const multi = bank.questions.filter((question) => question.type === "multi").length;
console.log(dim(`  multi-answer questions: ${multi}`));
