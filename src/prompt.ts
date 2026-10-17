import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

/**
 * Line-oriented input. Lines are buffered as they arrive, so the exam also runs
 * with piped input (`printf 'A\nB\n' | npm start`) and not just interactively.
 */
export class Prompt {
  private readonly rl: readline.Interface;
  private readonly buffered: string[] = [];
  private pending: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });

    this.rl.on("line", (line) => {
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      } else {
        this.buffered.push(line);
      }
    });

    this.rl.on("close", () => {
      this.closed = true;
      this.pending?.(null);
      this.pending = null;
    });

    // Ctrl+C ends the sitting cleanly so partial results are still saved.
    this.rl.on("SIGINT", () => this.close());
  }

  /** Resolves to `null` once input is exhausted or the user quits with Ctrl+C. */
  async ask(question: string): Promise<string | null> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      stdout.write(`${question}${buffered}\n`);
      return buffered.trim();
    }
    if (this.closed) return null;

    this.rl.setPrompt(question);
    this.rl.prompt();

    const line = await new Promise<string | null>((resolve) => {
      this.pending = resolve;
    });

    this.rl.setPrompt("");
    return line === null ? null : line.trim();
  }

  async pause(message: string): Promise<void> {
    await this.ask(message);
  }

  close(): void {
    if (!this.closed) this.rl.close();
  }
}

export type ParsedAnswer =
  | { kind: "answer"; keys: string[] }
  | { kind: "skip" }
  | { kind: "quit" }
  | { kind: "invalid"; reason: string };

/**
 * Accepts letters or 1-based numbers, in any order, separated by commas,
 * spaces or nothing at all: "b", "B D", "b,d", "2 4" all work.
 */
export function parseAnswer(input: string, optionKeys: readonly string[], expected: number): ParsedAnswer {
  const normalized = input.trim().toLowerCase();

  if (normalized === "") return { kind: "invalid", reason: "Enter an answer to continue." };
  if (normalized === "q" || normalized === "quit" || normalized === "exit") return { kind: "quit" };
  if (normalized === "s" || normalized === "skip") return { kind: "skip" };

  const tokens = normalized
    .replace(/[,;/+]/g, " ")
    .split(/\s+/)
    .flatMap((token) => (token.length > 1 && /^[a-z]+$/.test(token) ? token.split("") : [token]));

  const keys: string[] = [];
  for (const token of tokens) {
    let key: string | undefined;

    if (/^\d+$/.test(token)) {
      key = optionKeys[Number(token) - 1];
    } else if (/^[a-z]$/.test(token)) {
      const candidate = token.toUpperCase();
      key = optionKeys.includes(candidate) ? candidate : undefined;
    }

    if (key === undefined) {
      return { kind: "invalid", reason: `"${token}" is not one of ${optionKeys.join(", ")}.` };
    }
    if (!keys.includes(key)) keys.push(key);
  }

  if (keys.length !== expected) {
    return {
      kind: "invalid",
      reason:
        expected === 1
          ? "This question takes a single answer."
          : `This question needs exactly ${expected} answers — you gave ${keys.length}.`,
    };
  }

  return { kind: "answer", keys: keys.sort() };
}
