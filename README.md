# Claude Certification Exam Simulator

Practice exams for three Claude certifications, each with its own bank of 200 questions:

| Practice set | Exam code | Real exam length | Set id |
| --- | --- | --- | --- |
| Claude – Developer Foundations | CCDV-F | 53 items | `developer-foundations` (default) |
| Claude – Architect Foundations | CCAR-F | 60 items | `architect-foundations` |
| Claude – Architect Professional | CCAR-P | 63 items | `architect-professional` |

An interactive TypeScript CLI (and a matching browser app) runs a practice exam the length
of the real one, drawn from the chosen set's bank. It asks one question at a time, tells you immediately whether you were right,
explains why the correct answer is correct (and why the distractors are wrong), keeps a
running score, and writes the whole sitting — every question, your answer, and the
explanation — to a JSON file. You can quit at any point and pick up exactly where you
left off.

```
Question 7/53  ██░░░░░░░░░░░░░░░░░░░░░░  5/6 (83%)
Security and Safety · CCDV-176

A support agent built on Claude can fetch customer web pages with a tool. One fetched page
contains hidden text telling the model to email the conversation history to an outside
address. What is the most effective mitigation?

  A. Treat tool results as untrusted data and require human approval for outbound actions.
  B. Raise the temperature so the model is less likely to follow repeated instructions.
  C. Move the fetched page content into the system prompt so it has higher authority.
  D. Ask the model in the user turn to ignore any instructions it might see.

Your answer [s = skip, q = quit]: a

✔ Correct!
Answer: A. Treat tool results as untrusted data and require human approval for outbound actions.
Why: This is indirect prompt injection: instructions arrive inside content a tool returned.
     Least-privilege tools plus a human checkpoint on high-impact actions ...
Running score: 6/7 (86%)
```

## Requirements

Node.js 22.6 or newer — the app is written in TypeScript and executed directly by Node's
built-in type stripping, so there is nothing to compile and no runtime dependencies.
(`typescript` and `@types/node` are dev dependencies used only for `npm run typecheck`.)

## Getting started

```bash
npm install     # optional: only needed for npm run typecheck
npm start       # sit a full 53-question exam in the terminal
npm run web     # or sit it in the browser: http://localhost:5173
```

## Usage

```bash
npm start                              # 53-question exam sampled from the bank of 200
npm start -- --set architect-foundations  # sit a different practice set
npm start -- --count 200               # work through the entire bank
npm start -- --count 20                # a shorter set, weighted like the real exam
npm start -- --domain agents           # drill one domain
npm start -- --seed 42                 # reproduce an exact paper
npm start -- --resume                  # continue saved progress without being asked
npm start -- --new                     # start over, discarding saved progress
npm start -- --fast                    # no "press Enter" between questions
npm start -- --out results/monday.json # choose where results are written
npm start -- --help                    # all options
```

| Option | Description |
| --- | --- |
| `-s, --set <id>` | Practice set: `developer-foundations` (default), `architect-foundations`, `architect-professional` |
| `-n, --count <n>` | How many questions to ask (default: the real exam's length — 53, 60 or 63) |
| `-d, --domain <name>` | A domain name or a unique part of it (e.g. `"tool design"`); Developer also accepts `apps`, `models`, `agents`, `prompt`, `tools`, `security`, `code`, `eval` |
| `--seed <n>` | Reproduce the same question and option order |
| `--no-shuffle` | Ask questions and options in bank order |
| `--no-shuffle-options` | Shuffle questions but keep answer choices in order |
| `--fast` | Do not wait for Enter after each explanation |
| `-r, --resume` | Continue saved progress without the confirmation prompt |
| `--new` | Start a new exam and discard saved progress |
| `--session <file>` | Where progress is saved (default `.exam-session.json`, or `.exam-session-<set>.json` for the Architect sets) |
| `-o, --out <file>` | Results file (default `results/exam-<timestamp>.json`) |
| `--bank <file>` | Use a different question bank |

While a question is on screen: type a letter (`b`) or its number (`2`); for multi-answer
questions give all the letters at once (`AC`, `a c`, `1,3`); `s` skips the question and `q`
stops the exam and saves your place.

## Browser front end

`npm run web` starts a small local server and serves the same exam as a web page:

```bash
npm run web                     # http://localhost:5173
npm run web -- --port 5174      # or set PORT=5174
```

The dropdown in the top-left title bar switches between the practice sets. Each set keeps
its own saved progress, so you can leave an exam half-finished in one set, switch, and come
back to it later. The choice is remembered and also shows in the URL (`?set=architect-foundations`),
so a link can open a specific set.

The page covers the whole exam flow: pick the number of questions, a single domain, a seed
and the shuffle toggles on the start screen; answer one question at a time with the same
immediate feedback, explanation and running score; skip, or quit and save. Finishing shows
the summary — verdict, scaled score, domain bars and an expandable list of everything you
got wrong, explanations included — and lets you download the full results JSON, just like
the one the CLI writes.

Answering works by clicking or from the keyboard, matching the CLI: <kbd>A</kbd>–<kbd>H</kbd>
to choose (press several letters for "choose TWO" questions), <kbd>Enter</kbd> to submit and
then to advance, <kbd>S</kbd> to skip, <kbd>Q</kbd> to stop and save.

The browser build is fully static: the exam engine (selection, shuffling, grading, results)
runs in the page, the practice sets are listed in `web/data/sets.json` and each bank is fetched
from `web/data/` (next to the page itself), and progress is kept in the browser's `localStorage`, so a half-finished exam
survives closing the tab and reloads on the same machine. There are no server-side writes,
which is what makes the same page deployable to any static host.

## Hosting the browser app

The web app is plain static files with no build step — **the `web/` folder is the whole
site** (it contains the page, the assets and the question bank). Deploy it anywhere static
files are served:

- **Any static host** — Render / Netlify / Cloudflare Pages / S3 + CloudFront: point them at
  the repo with output directory **`web`** (or drag-and-drop the `web` folder — Netlify
  Drop works), no build command, no configuration needed.
- Works behind a path prefix too: all asset and data URLs in the page are relative.

Local preview without the Node server is just as easy: `npx serve .` from the repo root
and open `web/`.

> The terminal CLI is unchanged: it still writes `.exam-session.json` and `results/` on
> disk. The browser app does not share those files — its progress lives in the browser.

## Quitting and resuming

Progress is written to `.exam-session.json` after every answer, so stopping is always safe —
press `q` or Ctrl+C, or even close the terminal. The next launch shows what you had done and
offers to continue:

```
You have an exam in progress.
  Answered: 37/53    Score: 29/37    Last saved: 2 hours ago
Continue where you left off? [Y/n]
```

Answer `y` (or just press Enter) to carry on from question 38 with your score intact;
answer `n` to discard the saved progress and start a fresh exam. Because the session file
stores the questions exactly as they were shown to you, a resumed exam continues with the
same paper and the same answer ordering even if you edit the question bank in between.

Elapsed time accumulates across sittings, and the final results file records how many
sittings the exam took. The session file is deleted once you finish the exam, at which
point the results JSON is written.

## Scoring

Grading matches the real exam's conventions: multi-answer questions must be exactly right
to earn credit, skipped questions count as incorrect, and the report includes a 100–1000
scaled score with 720 as the pass mark (72%).

## Question bank

Each practice set is one JSON file in `web/data/`, listed in `web/data/sets.json`. Every bank
has 200 questions weighted to its exam guide's published domain weights, and records the
real exam's length (`examItems`) and its domains in blueprint order (`domains`).

`web/data/questions.json` — Developer Foundations (CCDV-F):

| Domain | Questions | Exam weight |
| --- | --- | --- |
| Applications and Integration | 67 | 33.1% |
| Model Selection and Optimization | 34 | 16.8% |
| Agents and Workflows | 29 | 14.7% |
| Prompt and Context Engineering | 22 | 11.0% |
| Tools and MCPs | 21 | 10.6% |
| Security and Safety | 16 | 8.1% |
| Claude Code | 6 | 3.1% |
| Eval, Testing, and Debugging | 5 | 2.6% |

`web/data/architect-foundations.json` — Architect Foundations (CCAR-F). Questions are framed
by the six scenarios in the exam guide (e.g. "Scenario: Customer Support Resolution Agent."):

| Domain | Questions | Exam weight |
| --- | --- | --- |
| Agentic Architecture & Orchestration | 54 | 27% |
| Tool Design & MCP Integration | 36 | 18% |
| Claude Code Configuration & Workflows | 40 | 20% |
| Prompt Engineering & Structured Output | 40 | 20% |
| Context Management & Reliability | 30 | 15% |

`web/data/architect-professional.json` — Architect Professional (CCAR-P):

| Domain | Questions | Exam weight |
| --- | --- | --- |
| Solution Design & Architecture | 34 | 17% |
| Claude Models, Prompting & Context Engineering | 26 | 13% |
| Integration | 38 | 19% |
| Evaluation, Testing & Optimization | 32 | 16% |
| Governance, Safety & Risk Management | 28 | 14% |
| Stakeholder Communication & Lifecycle Management | 28 | 14% |
| Developer Productivity & Operational Enablement | 14 | 7% |

A default Developer run asks 53 of the 200 (Architect: 60 or 63), sampled per domain so the weighting above is preserved
exactly, which means consecutive attempts cover different questions. Use `--count 200` to
work through the entire bank in one sitting.

Each entry looks like this:

```json
{
  "id": "CCDV-001",
  "domain": "Applications and Integration",
  "type": "single",
  "question": "A developer is building a chat interface on the Messages API...",
  "options": [{ "key": "A", "text": "Stream the response with server-sent events..." }],
  "correct": ["A"],
  "explanation": "Streaming returns content as it is generated, so...",
  "reference": "https://docs.claude.com/en/docs/build-with-claude/streaming"
}
```

Add your own questions by appending objects to the array — use `"type": "multi"` with two
or more entries in `correct` for "choose TWO" style questions. Then check the file:

```bash
npm run validate    # verifies every bank in sets.json and prints each domain weighting
```

## Results file

Each sitting writes a JSON file (default `results/exam-<timestamp>.json`) containing the
summary plus a full record of every question:

```json
{
  "exam": "Claude Certified Developer - Foundations",
  "scorePercent": 78,
  "scaledScore": 802,
  "passed": true,
  "sittings": 2,
  "domainBreakdown": [{ "domain": "Agents and Workflows", "asked": 8, "correct": 6, "percent": 75 }],
  "missedQuestionIds": ["CCDV-014", "CCDV-117"],
  "answers": [
    {
      "number": 1,
      "id": "CCDV-014",
      "yourAnswer": ["B"],
      "correctAnswer": ["A"],
      "status": "incorrect",
      "explanation": "When stop_reason is tool_use, the client must run the tool and...",
      "secondsSpent": 41
    }
  ]
}
```

Because the file keeps the explanation next to what you answered, it doubles as a study
sheet — reread the entries in `missedQuestionIds`, then run
`npm start -- --domain <weakest domain>` to drill that area.

## Project layout

```
web/data/sets.json     the practice sets shown in the picker and accepted by --set
web/data/*.json        one 200-question bank per set (questions.json is Developer Foundations)
src/index.ts           CLI entry point, argument parsing, resume handling
src/exam.ts            question loop, feedback, running score
src/server.ts          local web server (npm run web)
src/bank.ts            loading, validation, shuffling, domain-weighted sampling
src/session.ts         saving and restoring unfinished exams
src/report.ts          scoring, summary output, results JSON
src/grade.ts           grading rules shared by the terminal and the browser
src/prompt.ts          terminal input and answer parsing
src/validate.ts        question bank checker (npm run validate)
src/types.ts           shared types
src/ui.ts              colours and text wrapping
web/                   the whole static site: index.html, styles.css, app.js, data/
```

## Disclaimer

These are original practice questions written for study purposes. They are not actual exam
content and are not affiliated with or endorsed by Anthropic. Always confirm details
against the current Claude documentation, since models, features and limits change.
