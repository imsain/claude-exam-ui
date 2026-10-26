/**
 * Claude certification exam simulator — static browser build.
 *
 * The exam engine (question selection, shuffling, grading, results) is ported
 * from src/ and runs entirely in the browser; progress is kept in localStorage.
 * That means the app has no server and can be hosted on any static host
 * (GitHub Pages, Render, Netlify, ...). The practice sets are listed in
 * data/sets.json, and each set's question bank sits next to it in data/.
 */

const STORAGE_KEY = "claude-exam-ui:draft:v1";
const SET_KEY = "claude-exam-ui:set";

const NUMBER_WORD = ["zero", "one", "TWO", "THREE", "FOUR", "FIVE"];

const el = (id) => document.getElementById(id);

const screens = {
  start: el("screen-start"),
  question: el("screen-question"),
  summary: el("screen-summary"),
};

/** Current question plus the keys picked so far; `null` between questions. */
let sets = [];
let activeSet = null;
let bank = null;
let live = null; // the session in progress (also persisted to localStorage)
let current = null;
let selected = new Set();
let awaitingNext = false;
let finalResult = null;
let lastResult = null;
let busy = false;

/* ---------------- PRNG / shuffling (ported from src/bank.ts) ---------------- */

/** Mulberry32 — a tiny seedable PRNG so `seed` reproduces the same paper. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Re-letters the options after shuffling so keys stay A, B, C… top to bottom. */
function shuffleOptions(question, random) {
  const letters = "ABCDEFGH";
  const shuffled = shuffle(question.options, random);
  const correct = [];

  const options = shuffled.map((option, index) => {
    const key = letters[index];
    if (question.correct.includes(option.key)) correct.push(key);
    return { key, text: option.text };
  });

  return { ...question, options, correct: correct.sort() };
}

function sampleByDomain(pool, count, random) {
  const byDomain = new Map();
  for (const question of pool) {
    const bucket = byDomain.get(question.domain) ?? [];
    bucket.push(question);
    byDomain.set(question.domain, bucket);
  }

  const picked = [];
  const leftovers = [];

  for (const bucket of byDomain.values()) {
    const shuffled = shuffle(bucket, random);
    const share = Math.floor((bucket.length / pool.length) * count);
    picked.push(...shuffled.slice(0, share));
    leftovers.push(...shuffled.slice(share));
  }

  picked.push(...shuffle(leftovers, random).slice(0, count - picked.length));
  return shuffle(picked, random);
}

/** Picks the questions for one sitting, weighted per domain like the real exam. */
function selectQuestions(bankData, options) {
  const random = createRandom(options.seed ?? (Math.random() * 2 ** 32) >>> 0);

  let pool = bankData.questions;
  if (options.domain) pool = pool.filter((question) => question.domain === options.domain);
  if (pool.length === 0) throw new Error("No questions matched the requested domain.");

  const count = Math.min(options.count, pool.length);
  let selected;

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

/* ---------------- grading (ported from src/grade.ts) ---------------- */

function isCorrectAnswer(question, response) {
  return (
    response.length === question.correct.length &&
    response.every((key) => question.correct.includes(key))
  );
}

function answerStatus(question, response) {
  if (response.length === 0) return "skipped";
  return isCorrectAnswer(question, response) ? "correct" : "incorrect";
}

function recordAnswer(question, number, response, secondsSpent) {
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
    reference: question.reference ?? null,
    secondsSpent,
  };
}

/* ---------------- results (ported from src/report.ts) ---------------- */

function toScaledScore(percent) {
  return Math.round(100 + (percent / 100) * 900);
}

function buildResult(completed) {
  const answers = live.answers;
  const correct = answers.filter((answer) => answer.status === "correct").length;
  const incorrect = answers.filter((answer) => answer.status === "incorrect").length;
  const skipped = answers.filter((answer) => answer.status === "skipped").length;

  // Unanswered questions count against you, exactly like the real exam.
  const denominator = completed ? live.questions.length : answers.length || 1;
  const scorePercent = Math.round((correct / denominator) * 1000) / 10;

  const domainBreakdown = bank.domains.map((domain) => {
    const inDomain = answers.filter((answer) => answer.domain === domain);
    const domainCorrect = inDomain.filter((answer) => answer.status === "correct").length;
    return {
      domain,
      asked: inDomain.length,
      correct: domainCorrect,
      percent:
        inDomain.length === 0 ? 0 : Math.round((domainCorrect / inDomain.length) * 1000) / 10,
    };
  }).filter((score) => score.asked > 0);

  return {
    exam: live.exam,
    examCode: live.examCode,
    startedAt: live.startedAt,
    finishedAt: new Date().toISOString(),
    durationSeconds: elapsedOf(),
    sittings: live.sittings,
    completed,
    questionsAsked: answers.length,
    questionsInExam: live.questions.length,
    correct,
    incorrect,
    skipped,
    scorePercent,
    scaledScore: toScaledScore(scorePercent),
    passingScorePercent: live.passingScorePercent,
    passed: completed && scorePercent >= live.passingScorePercent,
    domainBreakdown,
    missedQuestionIds: answers
      .filter((answer) => answer.status !== "correct")
      .map((answer) => answer.id),
    answers,
  };
}

/* ---------------- session persistence (localStorage) ---------------- */

function elapsedOf() {
  if (live === null) return 0;
  return live.elapsedSeconds + Math.round((Date.now() - live.sittingStartedAt) / 1000);
}

/** Each set saves its own draft; the first set keeps the original key so older drafts still resume. */
function draftKey() {
  return activeSet === sets[0] ? STORAGE_KEY : `${STORAGE_KEY}:${activeSet.id}`;
}

function persist() {
  if (live === null) return;
  live.savedAt = new Date().toISOString();
  live.elapsedSeconds = elapsedOf();
  localStorage.setItem(draftKey(), JSON.stringify(live));
}

function loadDraft() {
  let raw;
  try {
    raw = localStorage.getItem(draftKey());
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const saved = JSON.parse(raw);
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.questions) ||
      saved.questions.length === 0 ||
      !Array.isArray(saved.answers)
    ) {
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(draftKey());
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/* ---------------- view helpers ---------------- */

function currentQuestionIndex() {
  return live === null ? 0 : live.answers.length;
}

function viewOf(state) {
  const question = state.questions[state.answers.length];
  if (question === undefined) return null;
  state.askedAt = Date.now();
  return {
    number: state.answers.length + 1,
    total: state.questions.length,
    id: question.id,
    domain: question.domain,
    type: question.type,
    question: question.question,
    options: question.options,
    expected: question.correct.length,
  };
}

function progressOf(state) {
  const answered = state.answers.length;
  const correct = state.answers.filter((answer) => answer.status === "correct").length;
  return {
    answered,
    total: state.questions.length,
    correct,
    percent: answered === 0 ? null : Math.round((correct / answered) * 100),
    elapsedSeconds: elapsedOf(),
    sittings: state.sittings,
  };
}

function bankMeta() {
  return {
    exam: bank.exam,
    examCode: bank.examCode,
    passingScorePercent: bank.passingScorePercent,
    totalQuestions: bank.questions.length,
    domains: bank.domains.map((domain) => ({
      name: domain,
      count: bank.questions.filter((question) => question.domain === domain).length,
    })).filter((entry) => entry.count > 0),
  };
}

/* ---------------- UI ---------------- */

function show(name) {
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
}

function showBanner(message, isError = false) {
  const banner = el("banner");
  banner.textContent = message;
  banner.classList.toggle("error", isError);
  banner.hidden = false;
}

function clearBanner() {
  el("banner").hidden = true;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

function describeAge(isoDate) {
  const minutes = Math.round((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderScoreChip(progress) {
  const chip = el("score-chip");
  if (!progress || progress.answered === 0) {
    chip.hidden = true;
    return;
  }

  const { correct, answered, percent } = progress;
  chip.hidden = false;
  chip.textContent = `${correct}/${answered} (${percent}%)`;
  chip.className = `chip ${percent >= 80 ? "good" : percent >= 72 ? "ok" : "bad"}`;
}

/** Serialises clicks so a double press cannot submit two answers. */
function guard(handler) {
  return async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await handler(...args);
    } catch (error) {
      showBanner(error.message, true);
    } finally {
      busy = false;
    }
  };
}

/* ---------------- start screen ---------------- */

function renderStart(saved) {
  const meta = bankMeta();
  const count = el("field-count");
  count.max = String(meta.totalQuestions);
  if (!count.value) count.value = String(meta.totalQuestions);

  const domain = el("field-domain");
  domain.replaceChildren();
  const all = new Option(`All domains (${meta.totalQuestions})`, "");
  domain.append(all);
  for (const entry of meta.domains) {
    domain.append(new Option(`${entry.name} (${entry.count})`, entry.name));
  }

  const card = el("resume-card");
  card.hidden = saved === null;
  if (saved !== null) {
    const { answers, questions } = saved;
    const correct = answers.filter((answer) => answer.status === "correct").length;
    const remaining = questions.length - answers.length;
    el("resume-detail").textContent =
      `Answered ${answers.length}/${questions.length} · Score ${correct}/${answers.length}` +
      ` · ${remaining} question${remaining === 1 ? "" : "s"} left · Last saved ${describeAge(saved.savedAt)}`;
  }

  renderScoreChip(null);
  show("start");
}

/* ---------------- question screen ---------------- */

function renderQuestion(view) {
  current = view;
  selected = new Set();
  awaitingNext = false;
  finalResult = null;

  el("q-counter").textContent = `Question ${view.number}/${view.total}`;
  el("q-progress").style.width = `${((view.number - 1) / view.total) * 100}%`;
  el("q-domain").textContent = `${view.domain} · ${view.id}`;
  el("q-text").textContent = view.question;

  const multi = el("q-multi");
  const needsHint = view.type === "multi" && !/choose\s/i.test(view.question);
  multi.hidden = !needsHint;
  if (needsHint) {
    multi.textContent = `(Choose ${NUMBER_WORD[view.expected] ?? view.expected}.)`;
  }

  const list = el("q-options");
  list.replaceChildren();
  for (const option of view.options) {
    const button = document.createElement("button");
    button.className = "option";
    button.dataset.key = option.key;

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = option.key;

    const text = document.createElement("span");
    text.textContent = option.text;

    button.append(key, text);
    button.addEventListener("click", () => toggle(option.key));
    list.append(button);
  }

  el("feedback").hidden = true;
  el("q-actions").hidden = false;
  el("btn-submit").disabled = true;
  renderScoreChip(progressOf(live));
  show("question");
}

function toggle(key) {
  if (current === null || awaitingNext) return;

  if (current.expected === 1) {
    selected = selected.has(key) ? new Set() : new Set([key]);
  } else if (selected.has(key)) {
    selected.delete(key);
  } else if (selected.size < current.expected) {
    selected.add(key);
  } else {
    showBanner(`This question needs exactly ${current.expected} answers — deselect one first.`);
    return;
  }

  clearBanner();
  for (const button of el("q-options").children) {
    button.classList.toggle("selected", selected.has(button.dataset.key));
  }
  el("btn-submit").disabled = selected.size !== current.expected;
}

function renderFeedback(response) {
  const progress = progressOf(live);
  awaitingNext = true;
  selected = new Set();

  for (const button of el("q-options").children) {
    const key = button.dataset.key;
    button.disabled = true;
    button.classList.remove("selected");
    if (response.feedback.correctAnswer.includes(key)) button.classList.add("correct");
    else if (response.feedback.yourAnswer.includes(key)) button.classList.add("wrong");
  }

  const verdict = el("fb-verdict");
  verdict.className = `verdict ${response.feedback.status}`;
  verdict.textContent =
    response.feedback.status === "correct"
      ? "✔ Correct!"
      : response.feedback.status === "skipped"
        ? "✘ Skipped."
        : `✘ Incorrect — you chose ${response.feedback.yourAnswer.join(", ")}.`;

  el("fb-answer").textContent = response.feedback.correctOptions
    .map((option) => `${option.key}. ${option.text}`)
    .join("  |  ");
  el("fb-why").textContent = response.feedback.explanation;

  const docs = el("fb-docs");
  docs.parentElement.hidden = response.feedback.reference === null;
  if (response.feedback.reference !== null) docs.href = response.feedback.reference;

  el("q-progress").style.width = `${(progress.answered / progress.total) * 100}%`;
  el("btn-next").textContent = response.done ? "See results" : "Next question";
  el("q-actions").hidden = true;
  el("feedback").hidden = false;
  renderScoreChip(progress);
  el("btn-next").focus();

  finalResult = response.done ? response.result : null;
}

/* ---------------- summary screen ---------------- */

function statEntry(label, value) {
  const wrap = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

function renderSummary(result) {
  lastResult = result;
  const badge = el("sum-verdict");
  if (result.passed) {
    badge.className = "badge pass";
    badge.textContent = "✔ PASS";
  } else if (result.completed) {
    badge.className = "badge fail";
    badge.textContent = "✘ FAIL";
  } else {
    badge.className = "badge incomplete";
    badge.textContent = "INCOMPLETE";
  }

  const denominator = result.completed ? result.questionsInExam : result.questionsAsked;
  el("sum-score").textContent = `${result.scorePercent}%`;
  el("sum-scaled").textContent = result.completed
    ? `${result.correct}/${denominator} correct · scaled score ${result.scaledScore}/1000 · pass mark 720`
    : `${result.correct}/${denominator} correct · ${result.questionsInExam - result.questionsAsked} questions remaining`;

  const stats = el("sum-stats");
  stats.replaceChildren(
    statEntry("Time", formatDuration(result.durationSeconds)),
    statEntry("Correct", String(result.correct)),
    statEntry("Incorrect", String(result.incorrect)),
    statEntry("Skipped", String(result.skipped)),
  );
  if (result.sittings > 1) stats.append(statEntry("Sittings", String(result.sittings)));

  const domains = el("sum-domains");
  domains.replaceChildren();
  for (const score of result.domainBreakdown) {
    const row = document.createElement("div");
    row.className = "domain-row";

    const name = document.createElement("span");
    name.textContent = score.domain;

    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = `fill ${score.percent >= 80 ? "" : score.percent >= 72 ? "mid" : "low"}`;
    fill.style.width = `${score.percent}%`;
    track.append(fill);

    const tally = document.createElement("span");
    tally.className = "tally";
    tally.textContent = `${score.percent}%  ${score.correct}/${score.asked}`;

    row.append(name, track, tally);
    domains.append(row);
  }

  const missed = result.answers.filter((answer) => answer.status !== "correct");
  el("sum-review-wrap").hidden = missed.length === 0;
  const review = el("sum-review");
  review.replaceChildren();
  for (const answer of missed) {
    const item = document.createElement("details");
    item.className = "review-item";

    const summary = document.createElement("summary");
    summary.textContent = `${answer.number}. ${answer.question}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      `${answer.id} · ${answer.domain} · correct: ${answer.correctAnswer.join(", ")}` +
      (answer.status === "skipped" ? " · skipped" : ` · you chose: ${answer.yourAnswer.join(", ")}`);
    summary.append(meta);

    const body = document.createElement("div");
    body.className = "body";
    for (const option of answer.options) {
      const line = document.createElement("p");
      line.className = "fb-line";
      line.textContent = `${option.key}. ${option.text}`;
      if (answer.correctAnswer.includes(option.key)) line.style.color = "var(--green)";
      body.append(line);
    }
    const why = document.createElement("p");
    why.className = "fb-line";
    why.textContent = answer.explanation;
    body.append(why);

    if (answer.reference) {
      const link = document.createElement("a");
      link.href = answer.reference;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Claude documentation";
      body.append(link);
    }

    item.append(summary, body);
    review.append(item);
  }

  el("btn-continue").hidden = result.completed;
  renderScoreChip(null);
  show("summary");
}

/* ---------------- flow ---------------- */

async function loadJson(path, what) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${what} unavailable (HTTP ${response.status}).`);
  return response.json();
}

async function loadBank(file) {
  const response = await fetch(`data/${file}`);
  if (!response.ok) throw new Error(`Question bank unavailable (HTTP ${response.status}).`);
  const data = await response.json();

  if (!Array.isArray(data?.questions) || data.questions.length === 0) {
    throw new Error("The question bank is empty or malformed.");
  }
  for (const question of data.questions) {
    if (!question.id || !question.question || !Array.isArray(question.options) || !Array.isArray(question.correct)) {
      throw new Error(`The question bank contains a malformed question (${question?.id ?? "unknown"}).`);
    }
  }
  return data;
}

/** Picks the set from ?set=, then the last one used, then the first listed. */
function initialSet() {
  const wanted = new URLSearchParams(location.search).get("set") ?? localStorage.getItem(SET_KEY);
  return sets.find((set) => set.id === wanted) ?? sets[0];
}

async function boot() {
  sets = await loadJson("data/sets.json", "Practice set list");
  const picker = el("set-picker");
  picker.replaceChildren(...sets.map((set) => new Option(set.label, set.id)));
  await openSet(initialSet());
}

/** Loads a practice set and shows its start screen; any exam in progress stays saved under its own set. */
async function openSet(set) {
  bank = await loadBank(set.file);
  activeSet = set;
  live = null;
  current = null;
  finalResult = null;

  el("set-picker").value = set.id;
  el("set-label").textContent = set.label;
  try {
    localStorage.setItem(SET_KEY, set.id);
  } catch {
    /* storage unavailable — the choice just won't stick */
  }
  const url = new URL(location.href);
  url.searchParams.set("set", set.id);
  history.replaceState(null, "", url);

  el("exam-meta").textContent =
    `${bank.examCode} · ${bank.questions.length} questions · pass mark ${bank.passingScorePercent}%`;
  document.title = `${bank.examCode} Exam Simulator`;
  el("field-count").value = "";

  const draft = loadDraft();
  if (draft !== null && draft.answers.length < draft.questions.length) {
    renderStart(draft);
    return;
  }
  if (draft !== null) clearDraft();
  renderStart(null);
}

function beginExam(options) {
  const questions = selectQuestions(bank, {
    count: Number(options.count),
    domain: options.domain || undefined,
    seed: options.seed === "" ? undefined : Number(options.seed),
    shuffleQuestions: options.shuffleQuestions,
    shuffleOptions: options.shuffleOptions,
  });

  const now = new Date().toISOString();
  live = {
    version: 1,
    exam: bank.exam,
    examCode: bank.examCode,
    passingScorePercent: bank.passingScorePercent,
    startedAt: now,
    savedAt: now,
    elapsedSeconds: 0,
    sittings: 1,
    sittingStartedAt: Date.now(),
    askedAt: null,
    questions,
    answers: [],
  };
  persist();

  const notice =
    questions.length < Number(options.count)
      ? `Only ${questions.length} question${questions.length === 1 ? "" : "s"} available` +
        `${options.domain ? ` in ${options.domain}` : ""} — running with those.`
      : null;
  const view = viewOf(live);
  if (notice) showBanner(notice);
  renderQuestion(view);
}

function resumeDraft(draft, announce) {
  draft.sittings += 1;
  draft.sittingStartedAt = Date.now();
  draft.askedAt = null;
  draft.elapsedSeconds = Math.max(0, draft.elapsedSeconds);
  live = draft;
  persist();

  const view = viewOf(live);
  if (view === null) {
    clearDraft();
    renderStart(null);
    return;
  }
  renderQuestion(view);
  if (announce) {
    showBanner(`Picking up at question ${view.number} of ${view.total}.`);
  }
}

/** Grades one answer, saves progress, and reveals the explanation. */
function answer(body) {
  const question = live.questions[live.answers.length];
  if (question === undefined) throw new Error("Every question has already been answered.");

  const secondsSpent =
    live.askedAt === null ? 0 : Math.max(0, Math.round((Date.now() - live.askedAt) / 1000));
  const number = live.answers.length + 1;
  live.answers.push(recordAnswer(question, number, body.keys, secondsSpent));
  live.askedAt = null;

  const completed = live.answers.length === live.questions.length;
  const feedback = {
    status: body.keys.length === 0 ? "skipped" : isCorrectAnswer(question, body.keys) ? "correct" : "incorrect",
    yourAnswer: body.keys,
    correctAnswer: question.correct,
    correctOptions: question.options.filter((option) => question.correct.includes(option.key)),
    explanation: question.explanation,
    reference: question.reference ?? null,
    secondsSpent,
  };

  if (completed) {
    clearDraft();
    return { feedback, progress: progressOf(live), done: true, result: buildResult(true) };
  }

  persist();
  return { feedback, progress: progressOf(live), done: false };
}

function quitExam() {
  const result = buildResult(false);
  persist();
  return result;
}

function downloadResult(result) {
  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `claude-${result.examCode.toLowerCase()}-result-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function backToStart() {
  clearBanner();
  renderStart(loadDraft());
}

/* ---------------- events ---------------- */

el("btn-start").addEventListener(
  "click",
  guard(() => {
    clearBanner();
    beginExam({
      count: el("field-count").value,
      domain: el("field-domain").value,
      seed: el("field-seed").value,
      shuffleQuestions: el("field-shuffle-questions").checked,
      shuffleOptions: el("field-shuffle-options").checked,
    });
  }),
);

el("start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  el("btn-start").click();
});

el("btn-resume").addEventListener("click", guard(() => resumeDraft(loadDraft(), true)));

el("btn-discard").addEventListener(
  "click",
  guard(async () => {
    clearDraft();
    live = null;
    await backToStart();
    showBanner("Saved progress discarded.");
  }),
);

el("btn-submit").addEventListener(
  "click",
  guard(async () => {
    if (current === null || selected.size !== current.expected) return;
    const payload = answer({ keys: [...selected] });
    clearBanner();
    renderFeedback(payload);
  }),
);

el("btn-skip").addEventListener(
  "click",
  guard(async () => {
    const payload = answer({ keys: [] });
    clearBanner();
    renderFeedback(payload);
  }),
);

el("btn-quit").addEventListener(
  "click",
  guard(async () => {
    const result = quitExam();
    clearBanner();
    renderSummary(result);
  }),
);

el("btn-next").addEventListener(
  "click",
  guard(async () => {
    if (finalResult !== null) {
      const result = finalResult;
      finalResult = null;
      renderSummary(result);
      return;
    }
    renderQuestion(viewOf(live));
  }),
);

el("btn-continue").addEventListener(
  "click",
  guard(async () => {
    const draft = loadDraft();
    if (draft !== null && draft.answers.length < draft.questions.length) {
      resumeDraft(draft, false);
    } else {
      await backToStart();
    }
  }),
);

el("btn-restart").addEventListener("click", guard(backToStart));

el("set-picker").addEventListener(
  "change",
  guard(async (event) => {
    const set = sets.find((entry) => entry.id === event.target.value);
    if (set === undefined || set === activeSet) return;
    clearBanner();
    persist(); // keep the elapsed time of an exam left mid-question
    try {
      await openSet(set);
    } catch (error) {
      event.target.value = activeSet.id;
      throw error;
    }
  }),
);

el("btn-download").addEventListener(
  "click",
  guard(async () => {
    if (lastResult === null) return;
    downloadResult(lastResult);
  }),
);

document.addEventListener("keydown", (event) => {
  if (screens.question.hidden || event.metaKey || event.ctrlKey || event.altKey) return;

  if (awaitingNext) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      el("btn-next").click();
    }
    return;
  }

  const key = event.key.toUpperCase();
  if (current !== null && current.options.some((option) => option.key === key)) {
    event.preventDefault();
    toggle(key);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (!el("btn-submit").disabled) el("btn-submit").click();
  } else if (key === "S") {
    event.preventDefault();
    el("btn-skip").click();
  } else if (key === "Q") {
    event.preventDefault();
    el("btn-quit").click();
  }
});

boot().catch((error) => {
  showBanner(`Could not load the exam: ${error.message}`, true);
});
