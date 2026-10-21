// Milestone 4 (Testing) — moderated user-testing report.
//
// After each moderated session the facilitator files one pseudonymised record
// (docs/user-testing/sessions/P*.json). This tool validates every record against
// the task catalogue in docs/user-testing/protocol.json, joins the findings that
// are tracked as GitHub issues labelled `user-testing`, and rewrites the
// generated block of docs/user-testing/findings-report.md. The narrative around
// that block is written by hand; the numbers inside it are only produced here, so
// they cannot drift from the session records.
//
// Scoring (docs/user-testing/README.md § Scoring):
//   task score 2 = completed unaided, 1 = completed with a facilitator assist or
//   only partly, 0 = failed / abandoned / wrong end state, null = not attempted
//   (requires a skipReason). Success rate = share of attempts scored 2, reported
//   with an adjusted-Wald 95% interval because n per task is small.
//
// A record that fails validation stops the run with every problem listed, rather
// than being skipped: a silently dropped session would understate the sample.
//
// Run:            npx tsx scripts/user_testing_report.ts
// Offline:        npx tsx scripts/user_testing_report.ts --issues-file issues.json
//                 (issues.json = `gh issue list --label user-testing --state all
//                  --limit 500 --json number,title,state,labels,url`)
// Without issues: npx tsx scripts/user_testing_report.ts --no-issues
// Synthetic demo: npx tsx scripts/user_testing_report.ts --fixture  (prints, writes nothing)
// Out:            docs/user-testing/findings-report.md (between the GENERATED markers)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

const FIXTURE = hasFlag("--fixture");
const FIXTURE_DIR = resolve(ROOT, "tests/fixtures/user-testing");
const PROTOCOL_FILE = resolve(ROOT, arg("--protocol") ?? "docs/user-testing/protocol.json");
const SESSIONS_DIR = FIXTURE
  ? resolve(FIXTURE_DIR, "sessions")
  : resolve(ROOT, arg("--sessions") ?? "docs/user-testing/sessions");
const ISSUES_FILE = FIXTURE ? resolve(FIXTURE_DIR, "issues.json") : arg("--issues-file");
const REPORT_FILE = resolve(ROOT, arg("--report") ?? "docs/user-testing/findings-report.md");
const TO_STDOUT = FIXTURE || hasFlag("--stdout");

const LABEL = "user-testing";
const ISSUE_LIMIT = 500;
const BEGIN = "<!-- BEGIN GENERATED: scripts/user_testing_report.ts — do not edit by hand -->";
const END = "<!-- END GENERATED -->";
const Z = 1.96; // 95%

// ── Types ────────────────────────────────────────────────────────────────────

type Score = 0 | 1 | 2;
type Comprehension = "correct" | "partial" | "incorrect";

interface Protocol {
  targets: {
    sessions: number;
    latamShare: number;
    defiNativeShare: number;
    minPerLanguage: Record<string, number>;
    minMobileSessions: number;
  };
  cohorts: string[];
  languages: string[];
  phases: { id: string; title: string }[];
  tasks: { id: string; phase: string; title: string; core: boolean }[];
  comprehension: { id: string; phase: string; title: string }[];
}

interface TaskResult {
  id: string;
  score: Score | null;
  skipReason?: string;
  timeSec?: number | null;
  seq?: number | null;
  assists?: number;
  issues?: number[];
  notes?: string;
}

interface Session {
  file: string;
  id: string;
  date: string;
  status: "completed" | "partial" | "no-show";
  facilitator: string;
  build?: string;
  language: string;
  cohorts: string[];
  country?: string;
  device: "desktop" | "mobile";
  wallet: string;
  network: "testnet" | "mainnet";
  tasks: TaskResult[];
  comprehension: { id: string; result: Comprehension | null; notes?: string }[];
  sus: number[] | null;
  confidence: number | null;
  issues: number[];
}

interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: { name: string }[];
}

// ── Load + validate ──────────────────────────────────────────────────────────

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isIssueList = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);

function validateSession(raw: Record<string, unknown>, file: string, p: Protocol): string[] {
  const errs: string[] = [];
  const e = (m: string) => errs.push(`${file}: ${m}`);
  const taskIds = new Set(p.tasks.map((t) => t.id));
  const compIds = new Set(p.comprehension.map((c) => c.id));

  if (typeof raw.id !== "string" || !/^P\d{2,}$/.test(raw.id))
    e(`id must look like "P01" (got ${JSON.stringify(raw.id)})`);
  else if (basename(file, ".json") !== raw.id) e(`file name must match id "${raw.id}"`);
  if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) e("date must be YYYY-MM-DD");
  if (!["completed", "partial", "no-show"].includes(raw.status as string))
    e("status must be completed | partial | no-show");
  if (typeof raw.facilitator !== "string" || !raw.facilitator) e("facilitator is required (initials)");
  if (!p.languages.includes(raw.language as string)) e(`language must be one of ${p.languages.join(", ")}`);
  if (!Array.isArray(raw.cohorts) || raw.cohorts.some((c) => !p.cohorts.includes(c)))
    e(`cohorts must be a list drawn from ${p.cohorts.join(", ")} (empty list = neither)`);
  if (!["desktop", "mobile"].includes(raw.device as string)) e("device must be desktop | mobile");
  if (typeof raw.wallet !== "string" || !raw.wallet) e("wallet is required");
  if (!["testnet", "mainnet"].includes(raw.network as string)) e("network must be testnet | mainnet");
  if (raw.status === "no-show") return errs;

  if (typeof raw.build !== "string" || !/^[0-9a-f]{7,40}$/.test(raw.build))
    e("build must be the git SHA of the app build tested (7–40 hex chars)");

  if (!Array.isArray(raw.tasks)) {
    e("tasks must be a list");
  } else {
    const seen = new Set<string>();
    for (const t of raw.tasks as TaskResult[]) {
      const where = `task ${t.id}`;
      if (!taskIds.has(t.id)) e(`${where}: unknown task id`);
      if (seen.has(t.id)) e(`${where}: listed twice`);
      seen.add(t.id);
      if (t.score === null) {
        if (!t.skipReason) e(`${where}: score null needs a skipReason`);
      } else if (![0, 1, 2].includes(t.score as number)) e(`${where}: score must be 0, 1, 2 or null`);
      if (t.timeSec != null && !isInt(t.timeSec, 0, 7200)) e(`${where}: timeSec must be whole seconds`);
      if (t.seq != null && !isInt(t.seq, 1, 7)) e(`${where}: seq must be 1–7`);
      if (t.assists != null && !isInt(t.assists, 0, 99)) e(`${where}: assists must be a count`);
      if (t.issues != null && !isIssueList(t.issues)) e(`${where}: issues must be a list of issue numbers`);
      if (t.score === 1 && !t.assists && !t.notes)
        e(`${where}: score 1 needs assists > 0 or a note saying what was partial`);
    }
    if (raw.status === "completed") {
      for (const t of p.tasks.filter((t) => t.core && !seen.has(t.id)))
        e(`core task ${t.id} missing (use score null + skipReason)`);
    }
  }
  if (raw.comprehension != null) {
    if (!Array.isArray(raw.comprehension)) e("comprehension must be a list");
    else
      for (const c of raw.comprehension as { id: string; result: unknown }[]) {
        if (!compIds.has(c.id)) e(`comprehension ${c.id}: unknown id`);
        if (c.result !== null && !["correct", "partial", "incorrect"].includes(c.result as string))
          e(`comprehension ${c.id}: result must be correct | partial | incorrect | null`);
      }
  }
  if (raw.sus != null) {
    if (!Array.isArray(raw.sus) || raw.sus.length !== 10 || raw.sus.some((v) => !isInt(v, 1, 5)))
      e("sus must be null or exactly 10 answers, each 1–5, in questionnaire order");
  }
  if (raw.confidence != null && !isInt(raw.confidence, 1, 7)) e("confidence must be 1–7 or null");
  if (raw.issues != null && !isIssueList(raw.issues)) e("issues must be a list of issue numbers");
  return errs;
}

function loadSessions(p: Protocol): Session[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
  const errs: string[] = [];
  const out: Session[] = [];
  for (const f of files) {
    let raw: Record<string, unknown>;
    try {
      raw = readJson(resolve(SESSIONS_DIR, f)) as Record<string, unknown>;
    } catch (err) {
      errs.push(`${f}: not valid JSON (${(err as Error).message})`);
      continue;
    }
    const v = validateSession(raw, f, p);
    if (v.length) {
      errs.push(...v);
      continue;
    }
    out.push({
      ...(raw as unknown as Session),
      file: f,
      tasks: (raw.tasks as TaskResult[]) ?? [],
      comprehension: (raw.comprehension as Session["comprehension"]) ?? [],
      sus: (raw.sus as number[] | null) ?? null,
      confidence: (raw.confidence as number | null) ?? null,
      issues: (raw.issues as number[]) ?? [],
    });
  }
  if (errs.length) {
    console.error(`✗ ${errs.length} problem(s) in session records — fix them and re-run:\n  ${errs.join("\n  ")}`);
    process.exit(1);
  }
  return out;
}

/** `null` = issues deliberately not loaded; the report then says so instead of showing zero findings. */
function loadIssues(): Issue[] | null {
  if (hasFlag("--no-issues")) return null;
  let issues: Issue[];
  if (ISSUES_FILE) {
    issues = readJson(resolve(ROOT, ISSUES_FILE)) as Issue[];
  } else {
    const json = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--label",
        LABEL,
        "--state",
        "all",
        "--limit",
        String(ISSUE_LIMIT),
        "--json",
        "number,title,state,labels,url",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    issues = JSON.parse(json) as Issue[];
    if (issues.length >= ISSUE_LIMIT) {
      console.error(`✗ gh returned ${issues.length} issues — the --limit cap; raise ISSUE_LIMIT so none are dropped.`);
      process.exit(1);
    }
  }
  return issues.filter((i) => i.labels.some((l) => l.name === LABEL));
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Adjusted-Wald (Agresti–Coull) interval: sane at the n ≈ 5–15 a usability study has. */
function adjustedWald(x: number, n: number): { p: number; lo: number; hi: number } {
  const p = n ? x / n : Number.NaN;
  const nAdj = n + Z * Z;
  const pAdj = (x + (Z * Z) / 2) / nAdj;
  const half = Z * Math.sqrt((pAdj * (1 - pAdj)) / nAdj);
  return { p, lo: Math.max(0, pAdj - half), hi: Math.min(1, pAdj + half) };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Standard SUS: odd items contribute (x − 1), even items (5 − x); sum × 2.5 → 0–100. */
const susScore = (a: number[]) => a.reduce((s, v, i) => s + (i % 2 === 0 ? v - 1 : 5 - v), 0) * 2.5;

// ── Formatting ───────────────────────────────────────────────────────────────

const pct = (v: number | null) => (v == null || Number.isNaN(v) ? "—" : `${Math.round(v * 100)}%`);
const num = (v: number | null, dp = 1) => (v == null ? "—" : v.toFixed(dp));
const ci = (x: number, n: number) => {
  if (!n) return "—";
  const w = adjustedWald(x, n);
  return `${pct(w.p)} (${pct(w.lo)}–${pct(w.hi)})`;
};
const secs = (v: number | null) =>
  v == null
    ? "—"
    : v >= 60
      ? `${Math.floor(v / 60)}m${String(Math.round(v % 60)).padStart(2, "0")}s`
      : `${Math.round(v)}s`;
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

const labelValue = (i: Issue, prefix: string) =>
  i.labels
    .map((l) => l.name)
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length));
const SEVERITY_ORDER = ["S1-critical", "S2-high", "S3-medium", "S4-low"];

// ── Report ───────────────────────────────────────────────────────────────────

function build(p: Protocol, all: Session[], issues: Issue[] | null): string {
  const out: string[] = [];
  const completed = all.filter((s) => s.status === "completed");
  const scored = all.filter((s) => s.status !== "no-show"); // partial sessions still contribute attempted tasks
  const N = completed.length;
  const has = (s: Session, c: string) => s.cohorts.includes(c);
  const cohortLabel: Record<string, string> = { latam: "LatAm", "defi-native": "DeFi-native" };

  out.push(
    `_Generated ${new Date().toISOString().slice(0, 10)} from ${all.length} session record(s)` +
      ` (${N} completed, ${all.filter((s) => s.status === "partial").length} partial,` +
      ` ${all.filter((s) => s.status === "no-show").length} no-show)` +
      (issues ? ` and ${issues.length} \`${LABEL}\` issue(s)._` : ". Findings were not loaded (`--no-issues`)._"),
  );

  if (FIXTURE) out.push("\n> ⚠️ **SYNTHETIC FIXTURE DATA** — demonstrates the report format only. Not real sessions.");

  // Session → issue links, used for frequency and traceability.
  const linkedBy = new Map<number, Set<string>>();
  for (const s of scored) {
    for (const n of [...s.issues, ...s.tasks.flatMap((t) => t.issues ?? [])]) {
      if (!linkedBy.has(n)) linkedBy.set(n, new Set());
      linkedBy.get(n)?.add(s.id);
    }
  }
  const byId = new Map(all.map((s) => [s.id, s]));

  // ── Milestone gates ──
  const t = p.targets;
  const latam = completed.filter((s) => has(s, "latam")).length;
  const defi = completed.filter((s) => has(s, "defi-native")).length;
  const mobile = completed.filter((s) => s.device === "mobile").length;
  const coreIds = p.tasks.filter((x) => x.core).map((x) => x.id);
  const untraced = scored.flatMap((s) =>
    s.tasks.filter((x) => x.score != null && x.score < 2 && !(x.issues ?? []).length).map((x) => `${s.id}/${x.id}`),
  );
  const unlabelled = (issues ?? []).filter(
    (i) => labelValue(i, "severity:").length !== 1 || labelValue(i, "flow:").length < 1,
  );
  const gates: [string, string, string, boolean][] = [
    ["Completed sessions", `≥ ${t.sessions}`, String(N), N >= t.sessions],
    [
      "LatAm share",
      `≥ ${pct(t.latamShare)}`,
      `${latam}/${N} (${pct(N ? latam / N : null)})`,
      N > 0 && latam / N >= t.latamShare,
    ],
    [
      "DeFi-native share",
      `≥ ${pct(t.defiNativeShare)}`,
      `${defi}/${N} (${pct(N ? defi / N : null)})`,
      N > 0 && defi / N >= t.defiNativeShare,
    ],
    ...Object.entries(t.minPerLanguage).map(([lang, min]): [string, string, string, boolean] => {
      const k = completed.filter((s) => s.language === lang).length;
      return [`Sessions in ${lang}`, `≥ ${min}`, String(k), k >= min];
    }),
    ["Mobile sessions", `≥ ${t.minMobileSessions}`, String(mobile), mobile >= t.minMobileSessions],
    ["Every assisted/failed task traced to a finding", "0 untraced", String(untraced.length), untraced.length === 0],
  ];
  if (issues) {
    gates.push([
      "Every finding has 1 severity + ≥1 flow label",
      "0 unlabelled",
      String(unlabelled.length),
      unlabelled.length === 0,
    ]);
  }
  out.push("\n### Milestone gates\n");
  out.push(
    table(
      ["Gate", "Target", "Actual", "Status"],
      gates.map(([g, tg, a, ok]) => [g, tg, a, ok ? "✅ PASS" : "❌ FAIL"]),
    ),
  );
  if (!issues) out.push("\n_Finding-label gate not evaluated: issues were not loaded._");

  if (!all.length) {
    out.push(
      "\n_No sessions recorded yet — sample, task and SUS tables appear once records land in `docs/user-testing/sessions/`._",
    );
    return out.join("\n");
  }

  // ── Sample ──
  out.push("\n### Sample\n");
  const dims: [string, (s: Session) => string][] = [
    ["Language", (s) => s.language],
    ["Device", (s) => s.device],
    ["Wallet", (s) => s.wallet],
    ["Network", (s) => s.network],
    ["Country", (s) => s.country ?? "—"],
  ];
  const sampleRows: string[][] = [];
  for (const c of p.cohorts)
    sampleRows.push(["Cohort", cohortLabel[c] ?? c, String(completed.filter((s) => has(s, c)).length)]);
  sampleRows.push(["Cohort", "Neither", String(completed.filter((s) => !s.cohorts.length).length)]);
  for (const [name, f] of dims) {
    const counts = new Map<string, number>();
    for (const s of completed) counts.set(f(s), (counts.get(f(s)) ?? 0) + 1);
    for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) sampleRows.push([name, k, String(v)]);
  }
  out.push(table(["Dimension", "Value", `Sessions (of ${N} completed)`], sampleRows));

  out.push("\n<details><summary>Per-session summary</summary>\n");
  out.push(
    table(
      [
        "Session",
        "Date",
        "Status",
        "Lang",
        "Cohorts",
        "Device · wallet",
        "Build",
        "Core tasks unaided",
        "SUS",
        "Confidence",
      ],
      all.map((s) => {
        const core = s.tasks.filter((x) => coreIds.includes(x.id) && x.score != null);
        return [
          s.id,
          s.date,
          s.status,
          s.language,
          s.cohorts.map((c) => cohortLabel[c] ?? c).join(", ") || "—",
          `${s.device} · ${s.wallet}`,
          s.build ? `\`${s.build.slice(0, 7)}\`` : "—",
          s.status === "no-show" ? "—" : `${core.filter((x) => x.score === 2).length}/${core.length}`,
          s.sus ? num(susScore(s.sus), 1) : "—",
          s.confidence ?? "—",
        ];
      }),
    ),
  );
  out.push("\n</details>");

  // ── Task success ──
  const attempts = (id: string, pool = scored) =>
    pool.flatMap((s) => s.tasks.filter((x) => x.id === id && x.score != null).map((x) => ({ s, x })));
  out.push("\n### Task success\n");
  out.push(
    "Success = completed unaided (score 2), with adjusted-Wald 95% interval. Completion = score ≥ 1 " +
      "(includes assisted). Time is the median over unaided completions only.\n",
  );
  const taskRows: (string | number)[][] = [];
  for (const ph of p.phases) {
    for (const task of p.tasks.filter((x) => x.phase === ph.id)) {
      const a = attempts(task.id);
      const ok = a.filter(({ x }) => x.score === 2);
      const linked = [...new Set(a.flatMap(({ x }) => x.issues ?? []))].sort((m, n) => m - n);
      const skipped = scored.flatMap((s) => s.tasks.filter((x) => x.id === task.id && x.score == null)).length;
      taskRows.push([
        `**${task.id}**${task.core ? "" : " _(stretch)_"}`,
        ph.title,
        task.title,
        `${a.length}${skipped ? ` (+${skipped} skipped)` : ""}`,
        ci(ok.length, a.length),
        pct(a.length ? a.filter(({ x }) => (x.score ?? 0) >= 1).length / a.length : null),
        secs(median(ok.map(({ x }) => x.timeSec).filter((v): v is number => v != null))),
        num(mean(a.map(({ x }) => x.seq).filter((v): v is number => v != null))),
        linked.map((n) => `#${n}`).join(" ") || "—",
      ]);
    }
  }
  out.push(
    table(
      [
        "Task",
        "Phase",
        "Description",
        "n",
        "Success (95% CI)",
        "Completion",
        "Median time",
        "Mean SEQ (1–7)",
        "Findings",
      ],
      taskRows,
    ),
  );

  // ── By phase × cohort ──
  out.push("\n### Success by phase and cohort\n");
  out.push(
    "Pooled over attempts in the phase (each participant contributes several attempts, so read these as directional).\n",
  );
  const groups: [string, (s: Session) => boolean][] = [
    ["All", () => true],
    ...p.cohorts.flatMap((c): [string, (s: Session) => boolean][] => [
      [cohortLabel[c] ?? c, (s) => has(s, c)],
      [`Not ${cohortLabel[c] ?? c}`, (s) => !has(s, c)],
    ]),
  ];
  out.push(
    table(
      ["Phase", ...groups.map(([g]) => g)],
      p.phases.map((ph) => [
        ph.title,
        ...groups.map(([, f]) => {
          const a = p.tasks.filter((x) => x.phase === ph.id).flatMap((task) => attempts(task.id, scored.filter(f)));
          return a.length ? `${ci(a.filter(({ x }) => x.score === 2).length, a.length)} · n=${a.length}` : "—";
        }),
      ]),
    ),
  );

  // ── End-to-end ──
  const fullCore = (s: Session, min: Score) =>
    coreIds.every((id) => s.tasks.some((x) => x.id === id && x.score != null && x.score >= min));
  out.push("\n### End-to-end journey (deposit → monitor → exit)\n");
  out.push(
    table(
      ["Measure", "Sessions", "Rate (95% CI)"],
      [
        [
          "Every core task completed (score ≥ 1)",
          `${completed.filter((s) => fullCore(s, 1)).length}/${N}`,
          ci(completed.filter((s) => fullCore(s, 1)).length, N),
        ],
        [
          "Every core task completed unaided (score 2)",
          `${completed.filter((s) => fullCore(s, 2)).length}/${N}`,
          ci(completed.filter((s) => fullCore(s, 2)).length, N),
        ],
      ],
    ),
  );

  // ── Comprehension ──
  out.push("\n### Risk comprehension checks\n");
  out.push(
    table(
      ["Check", "Phase", "Question", "Correct", "Partial", "Incorrect", "Correct rate (95% CI)"],
      p.comprehension.map((c) => {
        const r = scored.flatMap((s) => s.comprehension.filter((x) => x.id === c.id && x.result != null));
        const k = (v: Comprehension) => r.filter((x) => x.result === v).length;
        return [
          c.id,
          p.phases.find((ph) => ph.id === c.phase)?.title ?? c.phase,
          c.title,
          k("correct"),
          k("partial"),
          k("incorrect"),
          ci(k("correct"), r.length),
        ];
      }),
    ),
  );

  // ── SUS + confidence ──
  out.push("\n### Usability (SUS) and confidence\n");
  out.push(
    "SUS 0–100 (68 ≈ industry average). Confidence = “How confident would you be putting your own money into this?” (1–7).\n",
  );
  const susRows = groups.map(([g, f]) => {
    const sus = completed.filter(f).flatMap((s) => (s.sus ? [susScore(s.sus)] : []));
    const conf = completed.filter(f).flatMap((s) => (s.confidence != null ? [s.confidence] : []));
    return [
      g,
      sus.length,
      num(mean(sus)),
      num(median(sus)),
      sus.length ? `${num(Math.min(...sus))}–${num(Math.max(...sus))}` : "—",
      num(mean(conf)),
    ];
  });
  out.push(table(["Group", "n", "Mean SUS", "Median SUS", "Range", "Mean confidence"], susRows));

  // ── Findings ──
  out.push("\n### Findings (GitHub issues labelled `user-testing`)\n");
  if (!issues) {
    out.push("_Not loaded — re-run without `--no-issues`._");
  } else {
    const sev = (i: Issue) => labelValue(i, "severity:")[0] ?? "untriaged";
    const sevs = [...SEVERITY_ORDER, "untriaged"];
    out.push(
      table(
        ["Severity", "Open", "Closed", "Total"],
        sevs
          .map((s) => {
            const g = issues.filter((i) => sev(i) === s);
            return [
              s,
              g.filter((i) => i.state === "OPEN").length,
              g.filter((i) => i.state !== "OPEN").length,
              g.length,
            ];
          })
          .filter((r) => r[0] !== "untriaged" || (r[3] as number) > 0),
      ),
    );
    out.push("");
    const rows = [...issues].sort((a, b) => {
      const d = sevs.indexOf(sev(a)) - sevs.indexOf(sev(b));
      return d || (linkedBy.get(b.number)?.size ?? 0) - (linkedBy.get(a.number)?.size ?? 0) || a.number - b.number;
    });
    out.push(
      table(
        ["Issue", "Severity", "Flow", "Seen in", "Cohorts affected", "State"],
        rows.map((i) => {
          const ids = [...(linkedBy.get(i.number) ?? [])].sort();
          const cohorts = p.cohorts
            .map((c) => [c, ids.filter((id) => byId.get(id)?.cohorts.includes(c)).length] as const)
            .filter(([, k]) => k > 0)
            .map(([c, k]) => `${cohortLabel[c] ?? c} ${k}`);
          return [
            `[#${i.number}](${i.url}) ${i.title.replaceAll("|", "\\|")}`,
            sev(i),
            labelValue(i, "flow:").join(", ") || "—",
            ids.length ? `${ids.length}/${scored.length} (${ids.join(", ")})` : "—",
            cohorts.join(" · ") || "—",
            i.state.toLowerCase(),
          ];
        }),
      ),
    );
  }

  // ── Traceability ──
  const known = new Set((issues ?? []).map((i) => i.number));
  const dangling = issues ? [...linkedBy.keys()].filter((n) => !known.has(n)).sort((a, b) => a - b) : [];
  const orphan = (issues ?? []).filter((i) => !linkedBy.has(i.number));
  if (untraced.length || unlabelled.length || dangling.length || orphan.length) {
    out.push("\n### Traceability to fix\n");
    if (untraced.length) out.push(`- Assisted/failed tasks with no linked finding: ${untraced.join(", ")}`);
    if (unlabelled.length)
      out.push(`- Findings missing a severity or flow label: ${unlabelled.map((i) => `#${i.number}`).join(", ")}`);
    if (dangling.length)
      out.push(
        `- Issue numbers referenced by sessions but not labelled \`${LABEL}\`: ${dangling.map((n) => `#${n}`).join(", ")}`,
      );
    if (orphan.length)
      out.push(
        `- \`${LABEL}\` issues no session links to (add to a session's \`issues\`): ${orphan.map((i) => `#${i.number}`).join(", ")}`,
      );
  }

  return out.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const protocol = readJson(PROTOCOL_FILE) as Protocol;
  const sessions = loadSessions(protocol);
  const issues = loadIssues();
  const block = build(protocol, sessions, issues);

  if (TO_STDOUT) {
    console.log(block);
    return;
  }
  const report = readFileSync(REPORT_FILE, "utf8");
  const a = report.indexOf(BEGIN);
  const b = report.indexOf(END);
  if (a < 0 || b < a) {
    console.error(`✗ ${REPORT_FILE} has no GENERATED markers; add\n${BEGIN}\n${END}`);
    process.exit(1);
  }
  writeFileSync(REPORT_FILE, `${report.slice(0, a + BEGIN.length)}\n\n${block}\n\n${report.slice(b)}`, "utf8");
  console.log(`✓ ${REPORT_FILE.replace(`${ROOT}/`, "")} updated (${sessions.length} sessions).`);
}

main();
