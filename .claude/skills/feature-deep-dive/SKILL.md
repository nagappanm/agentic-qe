---
name: feature-deep-dive
description: "Use when you have a PR and need to understand the feature behind it: reads the PRD, ADRs and manuals, walks the diff, then explains what the feature does, which areas it puts at risk, and what to test. Produces an evidence-cited briefing and a risk-ranked test charter for reviewers, testers, and onboarding engineers."
user-invocable: true
trust_tier: 0
category: investigation
---

# Feature Deep Dive

Runbook-style skill that turns a pull request into a **feature briefing**: what the feature is, how it actually works, what it can break, and what to test.

Not the same as `/pr-review` (which judges the PR) or `/sherlock-review` (which verifies a claim). This skill assumes the PR is going in and asks: *do we understand it well enough to test it?*

## Activation

```
/feature-deep-dive <pr-number | pr-url | branch | commit-range>
```

## Arguments

- `<target>` — PR number (`1234`), PR URL, branch (`feat/x`), or range (`main...HEAD`). If omitted, ask the user; do not guess from the current branch.
- `--depth quick|standard|deep` — `quick` = Phases 1–3 only, `standard` (default) = all phases, `deep` = adds reverse-dependency tracing and a test-coverage delta per changed file.
- `--save <path>` — write the briefing to a file. Default is chat only. Never write to the repo root; use `docs/reviews/` or `reports/`.

## Ground Rules

These are what separate a briefing from a plausible-sounding summary.

1. **Cite or don't claim.** Every factual statement carries a `path/to/file.ts:42` or a doc path. No citation = don't write it.
2. **Tag the source of every claim**: `[SPEC]` (from a doc), `[CODE]` (read in the diff or source), `[INFERRED]` (your reasoning — say so), `[UNKNOWN]` (gap — list it in Open Questions).
3. **Read the diff, not the PR description.** The description is a claim about the diff. Read every changed file end to end before writing a word of the briefing.
4. **Absence is a finding.** No PRD, no tests, no migration plan, no docs update — each of those is a line in the report, not something to skip past.
5. **Never state behavior you have not read.** If you need to know what a downstream module does, open it.

---

## Phase 1 — Frame the Change

```bash
gh pr view <target> --json title,body,author,baseRefName,headRefName,labels,files,commits
gh pr diff <target>
gh pr diff <target> --name-only
gh pr view <target> --comments        # reviewer context, linked issues
```

No `gh`? Use the GitHub MCP tools (`pull_request_read`, `get_file_contents`) or `git diff <base>...<head>`.

Build a **change inventory** before interpreting anything:

| File | Layer (api/domain/data/ui/cli/config/test/docs) | Kind (new/modified/deleted/moved) | ± LOC | Reason it's here |
|------|------|------|------|------|

```bash
git diff --stat <base>...<head>
git log --oneline <base>..<head>
```

Flag immediately: changes to migrations, lockfiles, CI config, public exports, or generated files mixed into a feature PR.

## Phase 2 — Find the Intent (docs, PRD, manuals)

Walk this ladder in order. Stop when you have the requirement, but record which rungs were empty.

1. **PR body + linked issues** — `gh pr view <target> --json body`, then open every `#123` / `JIRA-456` reference.
2. **PRD / spec / RFC / design docs** — search on **two tracks**, because they hit different targets:

   **Track A — identifiers** (finds *code and tests*, rarely docs): the symbols the diff adds.
   ```bash
   git diff <base>...<head> \
     | grep -oE "^\+export (async function|function|const|class|interface|type) [A-Za-z_]+" \
     | awk '{print $NF}' | sort -u
   ```

   **Track B — user-visible behavior phrases** (finds *docs*): the strings the diff makes a
   user or operator actually see. Docs describe behavior, not symbol names.
   ```bash
   git diff <base>...<head> | grep -E "^\+" \
     | grep -oE "(Error\(|message:|description:)[^;]*'[^']{15,}'" \
     | grep -oE "'[^']{15,}'" | sort -u
   ```

   Then search each track against the right tree:
   ```bash
   # scope to doc dirs first — a repo-wide name match drowns in source files
   find docs/ doc/ spec/ specs/ .github/ -iname "*.md" 2>/dev/null \
     | grep -iE "prd|spec|rfc|design|requirement"
   grep -rl "<identifier>" src/ tests/ --include="*.ts"     # track A
   grep -ril "<behavior phrase>" docs/ --include="*.md"     # track B
   ```

   **Triage the hits — a mention is not a spec.** A broad keyword returns a dozen docs that
   reference the topic in passing. Rank before reading:
   ```bash
   # match density, not mere presence
   for f in $(grep -ril "<term>" docs/ --include="*.md"); do
     echo "$(grep -ic '<term>' "$f") $f"; done | sort -rn | head
   ```
   Read in this order: the doc whose **title or a heading owns the topic** → highest match
   density → most recently modified before the change. One hit with one mention can still be
   the only real source; say so rather than padding the ledger with near-misses.
3. **ADRs** — architectural constraints the feature must respect.
   ```bash
   find docs -iname "ADR-*" | xargs grep -l "<feature-keyword>"
   ```
4. **User-facing manuals** — README, `docs/guides/`, CLI `--help` text, MCP tool descriptions. These define the *contract with users* that the PR may be changing.
5. **CHANGELOG** — how the team has described comparable changes before.
6. **Tests as executable spec** — existing tests around the touched modules encode the old contract. Read them before deciding what the new contract is.
7. **External trackers** — when an Atlassian MCP connector is available, pull the Jira issue and any linked Confluence PRD (`getJiraIssue`, `searchConfluenceUsingCql`). Most PRDs live outside the repo.

Then build the **intent ledger**:

| Requirement (source) | Where satisfied in diff | Status |
|---|---|---|
| "Users can export as CSV" (docs/prd/export.md:31) | `src/export/csv.ts:12-88` | Met |
| "Export must stream >100MB" (docs/prd/export.md:38) | — | **Not found** |

**Divergence check** — the highest-value output of this phase. For each row, ask: does the code do *more* than the spec (scope creep, untracked surface), *less* (gap), or *differently* (silent design change)? Every divergence goes in the report.

If no spec exists anywhere: say so explicitly, reconstruct intent from the diff and tests, and mark the whole ledger `[INFERRED]`.

## Phase 3 — Explain the Feature

Explain it twice, at two altitudes.

**A. In plain language (3–5 sentences).** What can a user do after this PR that they could not before? Name the user, the trigger, and the observable outcome. No class names, no file paths.

**B. The mechanism.** Trace one full path end to end with citations at each hop:

```
entry point (CLI cmd / HTTP route / MCP tool / event)  →  src/...:NN
  → validation / auth                                  →  src/...:NN
  → core logic (the actual new behavior)               →  src/...:NN
  → persistence / external call                        →  src/...:NN
  → response / side effect / emitted event             →  src/...:NN
```

Then state the **before → after** delta for each changed behavior, including defaults, error paths, and anything that used to throw and now doesn't (or vice versa).

## Phase 4 — Impact Areas (blast radius)

**Direct** — files in the diff. **First-order** — everything that calls them:

```bash
# who imports the changed modules — anchor on the path so generic names
# like `memory` don't match every file containing that word
for f in $(git diff --name-only <base>...<head> | grep -E '\.(ts|js|py)$' | grep -v test); do
  b=$(basename "$f" | sed 's/\.[^.]*$//')
  # a barrel file is imported by its DIRECTORY name; matching on "index"
  # matches every barrel in the repo and inflates the count wildly
  if [ "$b" = "index" ]; then m=$(basename "$(dirname "$f")"); else m="$b"; fi
  echo "== $f  (module: $m)"
  grep -rnE "(from|require\(|import\()[[:space:]]*['\"][^'\"]*/$m(/index)?(\.js|\.ts)?['\"]" src/ --include="*.ts" | head -10
done

# what the PR newly exposes — then grep each symbol for call sites
grep -nE "^\+.*(export (async )?function|export class|export const)" <(git diff <base>...<head>)
```

An **empty importer list is a result, not a dead end**: the file is either a true entry point (CLI command, route handler, worker) or reached some other way. Find the wiring before concluding nothing depends on it — dynamic `import()`, DI containers, command registries, and config-driven plugin loaders all hide callers from a static grep.

Then walk the **non-code impact checklist** — these are where feature PRs actually hurt:

| Area | Ask | Hit? |
|---|---|---|
| Public API / exports | Signature, return shape, or error type changed? | |
| CLI ↔ MCP parity | Both paths updated? (they diverge constantly — verify each separately) | |
| Data & migrations | Schema change, backfill, or persisted shape change? Reversible? | |
| Config & flags | New env var, default changed, flag defaulting on? | |
| Contracts & events | Request/response, message, or event payload changed? Consumers? | |
| Producer / consumer completeness | If the change makes some input **required**, does a producer exist for every required input? Enumerate both sides and diff them. | |
| Concurrency & state | Shared state, caching, ordering, idempotency? | |
| Performance | New N+1, sync I/O on a hot path, unbounded loop or buffer? | |
| Security | New input boundary, authz decision, secret handling, PII, path traversal? | |
| Backward compat | Old clients / old data / old sessions still work? Rollback safe? | |
| Observability | Failures visible in logs, metrics, traces? | |
| Docs & strings | Manual, README, help text, error messages updated? | |

Score each hit area so the test charter can be ordered:

```
blast radius = exposure (who sees it) × coupling (how many callers) × reversibility (cheap or hard to undo)
```
Call each area **High / Medium / Low** and say in one clause why.

## Phase 5 — What to Test

Produce a **risk-ranked test charter**. Phrase every idea as an action plus an observable result — never "Verify that…" (see `/test-idea-rewriting`).

| # | Impact area | Risk if broken | Test idea (action → observation) | Level | Priority |
|---|---|---|---|---|---|
| 1 | CSV export streaming | OOM on large tenants | Submit a 200MB export; measure peak RSS stays under the limit and the file completes | integration | P0 |
| 2 | Export authz | Cross-tenant leak | Request tenant B's export as tenant A; observe 403 and no row in the audit log | integration | P0 |

Cover these classes deliberately — an empty class is itself a finding:

- **Happy path** — the requirement from the intent ledger, one test per row.
- **Boundaries** — empty, one, max, over-max, unicode, null/undefined.
- **Negative & error paths** — every new `throw`/error branch in the diff.
- **State & concurrency** — repeat calls, parallel calls, interrupted calls, retries.
- **Regression candidates** — the first-order callers from Phase 4. What used to work and must still work?
- **Non-functional** — performance, security, accessibility, i18n, where Phase 4 flagged them.
- **Migration & rollback** — upgrade with old data, downgrade with new data.
- **Observability** — when it fails, can an on-call engineer tell?

Then the **coverage delta** (`--depth deep`): for each changed source file, list the tests that already exercise it and the ones that don't exist yet.

```bash
git diff --name-only <base>...<head> | grep -v test
# for each: find matching tests
find tests -iname "*<module>*"
grep -rn "<exported-symbol>" tests/ | head
```

Finally, state **what not to test** and why — unchanged paths, vendored code, already-covered branches. A charter that scopes out is a charter people follow.

## Phase 6 — Report

```markdown
# Feature Deep Dive: <PR title> (#<number>)

**Author**: <author> · **Base**: <base> ← **Head**: <head> · **Files**: <n> · **±LOC**: <n>

## 1. What this feature does
<plain-language paragraph — user, trigger, observable outcome>

## 2. Intent & sources
| Doc | Path / link | Used |
|---|---|---|
<ladder results, including the rungs that were empty>

**Divergences from spec**
- <spec says X, code does Y — path:line> `[SPEC]` vs `[CODE]`

## 3. How it works
<mechanism trace with citations>

**Before → After**
| Behavior | Before | After |
|---|---|---|

## 4. Impact areas
| Area | Blast radius | Why | Evidence |
|---|---|---|---|

## 5. Test charter
<risk-ranked table>

**Existing coverage**: <files already covered>
**Coverage gaps**: <files/branches with no test>
**Out of scope**: <what not to test and why>

## 6. Open questions
- [ ] <question> — owner: <who can answer>

## 7. Confidence
<High/Medium/Low> — <what you read vs what you inferred; name what would raise it>
```

Every briefing ends with Open Questions and Confidence. A deep dive with no open questions usually means the reading wasn't deep.

## Composition

Before this skill:
- **`/qe-code-intelligence`** — index a large or unfamiliar codebase first so tracing is cheap.

After this skill:
- **`/pr-review`** — now judge the PR, with the feature understood.
- **`/risk-based-testing`** — expand the charter into a prioritized test plan.
- **`/qe-test-generation`** — turn charter rows into executable tests.
- **`/sfdipot-product-factors`** — widen coverage across product factors for a large feature.
- **`/test-idea-rewriting`** — clean up any passive charter phrasing.
- **`qe-impact-analyzer`** agent — compute blast radius mechanically for very large diffs.

## Gotchas

- **The PR description is marketing.** Treat it as a hypothesis to test against the diff, not as a source.
- **A small diff is not a small feature.** A one-line default change can have the widest blast radius in the repo; size the risk by exposure, not by LOC.
- **Stale PRDs mislead worse than missing ones.** Check the doc's last-modified date against the PR; an old spec that contradicts the code is a divergence, not a requirement.
- **Deleted tests are a signal.** If the diff removes or skips tests, find out which behavior stopped being guaranteed.
- **CLI and MCP paths diverge.** A fix or feature landing on one path is routinely absent on the other — check both, always, and list the missing one as an impact area.
- **A grep that finds nothing has two meanings.** Either nothing calls it, or it's wired dynamically. Decide which before you size the blast radius — under-counting callers is how a "low risk" label lands on the riskiest change in the PR.
- **Barrel files lie about their blast radius.** `index.ts` matched by basename reports every barrel import in the repo — a real run here returned 473 importers where the true count was 2. Resolve barrels by directory name, and sanity-check any count that looks too big to be real.
- **A new required input with no producer is the highest-value finding in the diff.** When a feature starts demanding evidence, config, or an event, list what it requires and what actually writes it. The gap is silent at build time and total at runtime — the gate simply never opens.
- **Generated files hide real changes.** Lockfiles, snapshots, and build output pad the diff; exclude them from the inventory but read migrations and schema files line by line.
- **Don't grade the code.** Quality judgment belongs in `/pr-review`. This skill explains and scopes; mixing the two buries the testing signal.
