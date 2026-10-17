/** ANSI colours and small terminal formatting helpers. */

const supportsColor =
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const wrap = (code: string) => (text: string) =>
  supportsColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("36");
export const magenta = wrap("35");

export const CHECK = "\u2714";
export const CROSS = "\u2718";

const TARGET_WIDTH = 88;

function terminalWidth(): number {
  const columns = process.stdout.columns;
  return Math.min(TARGET_WIDTH, typeof columns === "number" && columns > 40 ? columns : TARGET_WIDTH);
}

/** Greedy word wrap, with `indent` applied to every line after the first. */
export function wrapText(text: string, indent = 0): string {
  const width = terminalWidth() - indent;
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map((line, i) => (i === 0 ? line : pad + line)).join("\n");
}

export function rule(char = "\u2500"): string {
  return dim(char.repeat(terminalWidth()));
}

export function heading(text: string): string {
  return `\n${rule()}\n${bold(text)}\n${rule()}`;
}

/** Fixed-width progress bar, e.g. `[████░░░░] 50%`. */
export function progressBar(fraction: number, width = 24): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `${green("\u2588".repeat(filled))}${dim("\u2591".repeat(width - filled))}`;
}
