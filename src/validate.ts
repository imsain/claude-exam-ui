#!/usr/bin/env node
/** Sanity-checks every bank listed in web/data/sets.json (or one given path) and prints its domain weighting. */
import { readFile } from "node:fs/promises";
import { bankPathOf, loadSets, validateBank } from "./bank.ts";
import type { QuestionBank } from "./types.ts";
import { CHECK, CROSS, bold, dim, green, red } from "./ui.ts";

const paths = process.argv[2] ? [process.argv[2]] : (await loadSets()).map(bankPathOf);
let failed = false;

for (const path of paths) {
  const bank = JSON.parse(await readFile(path, "utf8")) as QuestionBank;
  const problems = validateBank(bank);

  if (problems.length > 0) {
    failed = true;
    console.error(red(`${CROSS} ${problems.length} problem(s) in ${path}`));
    for (const problem of problems) console.error(`  - ${problem}`);
    continue;
  }

  console.log(green(`${CHECK} ${bank.examCode}: ${bank.questions.length} questions look good`));
  console.log(`${bold("Domain weighting")} ${dim(`(${bank.exam})`)}`);

  const width = Math.max(...bank.domains.map((domain) => domain.length));
  for (const domain of bank.domains) {
    const inDomain = bank.questions.filter((question) => question.domain === domain);
    const share = ((inDomain.length / bank.questions.length) * 100).toFixed(0);
    console.log(`  ${domain.padEnd(width)} ${String(inDomain.length).padStart(3)}  ${dim(`${share}%`)}`);
  }

  const multi = bank.questions.filter((question) => question.type === "multi").length;
  console.log(dim(`  multi-answer questions: ${multi}\n`));
}

if (failed) process.exit(1);
