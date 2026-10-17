/**
 * Saved progress for an exam that was left unfinished. The file stores the exact
 * questions as they were presented (already shuffled and re-lettered) so a
 * resumed sitting continues with the same paper even if the bank changes.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AnsweredQuestion, Question } from "./types.ts";

export const SESSION_VERSION = 1;

export interface SavedSession {
  version: number;
  exam: string;
  examCode: string;
  savedAt: string;
  startedAt: string;
  elapsedSeconds: number;
  sittings: number;
  bankPath: string;
  outPath: string | null;
  questions: Question[];
  answers: AnsweredQuestion[];
}

export type SessionLookup =
  | { status: "none" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; session: SavedSession };

export function defaultSessionPath(root: string): string {
  return join(root, ".exam-session.json");
}

export function questionsRemaining(session: SavedSession): number {
  return session.questions.length - session.answers.length;
}

export async function loadSession(path: string): Promise<SessionLookup> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    return { status: "invalid", reason: (error as Error).message };
  }

  let session: SavedSession;
  try {
    session = JSON.parse(raw) as SavedSession;
  } catch {
    return { status: "invalid", reason: "the file is not valid JSON" };
  }

  if (session.version !== SESSION_VERSION) {
    return { status: "invalid", reason: `unsupported session version ${session.version}` };
  }
  if (!Array.isArray(session.questions) || session.questions.length === 0) {
    return { status: "invalid", reason: "no questions were saved" };
  }
  if (!Array.isArray(session.answers) || session.answers.length > session.questions.length) {
    return { status: "invalid", reason: "the saved answers do not match the saved questions" };
  }

  return { status: "ok", session };
}

/** Writes through a temporary file so an interrupted save cannot corrupt progress. */
export async function saveSession(session: SavedSession, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function clearSession(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Moves an unreadable session file aside so it stops interfering with new exams. */
export async function quarantineSession(path: string): Promise<string | null> {
  const target = `${path}.corrupt`;
  try {
    await rename(path, target);
    return target;
  } catch {
    return null;
  }
}
