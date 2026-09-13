---
name: "defect-report"
description: "File defects to Jira, GitHub or a local file as a structured, schema-validated report an LLM can root-cause from and a human can read. Captures the DOM components where the bug surfaces, correlates front-end, network and back-end evidence on one timeline, and states a layer verdict. Use when reporting a bug, filing a ticket, investigating a front-end/back-end integration failure, or turning test/browser evidence into a defect report."
category: bug-management
priority: high
tokenEstimate: 1400
agents: [qe-root-cause-analyzer, qe-integration-tester, qe-defect-predictor, qe-browser]
trust_tier: 3
tags: [defects, bugs, reporting, jira, github, integration, dom, root-cause, triage]
validation:
  schema_path: schemas/output.json
  validator_path: scripts/validate-config.json
  eval_path: evals/defect-report.yaml
---

# Defect Report

Produces **one** canonical JSON defect report and renders it three ways — Markdown for humans, Jira ADF, a GitHub issue body. One artifact, three projections, so a human and an agent never read diverging accounts of the same defect.

<default_to_action>
1. **CAPTURE** DOM evidence if the defect is reproducible in a browser: `capture-dom-context.js --url <url> --testid <failing-element>`
2. **BUILD** the report: `build-report.js --report draft.json [--capture capture.json] --out report.json`
3. **REDACT** before anything leaves the machine: `redact.js --in report.json --write clean.json`
4. **RENDER** for the destination: `render.js --in clean.json --format jira-adf|github-body|markdown`
5. **FILE** only on explicit confirmation, after a fingerprint dedupe search. Default is a local file.

Never skip 3. Never do 5 without being asked.
</default_to_action>

## Why this shape

An LLM asked to root-cause a front-end/back-end bug fails for a structural reason: the facts it needs — which component broke, which request it fired, what the backend actually returned — arrive scattered across a screenshot, a pasted stack trace, and a sentence. It has to re-derive a correlation the reporter already had.

So the report is organised around a **correlation ID**, not a narrative:

```
EV-01  ui       +0.00s  click [data-testid=place-order] → button disabled
EV-04  backend  +0.04s  order-svc used LegacyOrderSerializer (PRICING_V2=false), omits `total`
EV-02  network  +0.04s  POST /api/v2/orders → 200 OK, body has no `data.total`
EV-03  ui       +0.06s  TypeError: cannot read 'toFixed' of undefined at OrderSummary.tsx:42
```

Four observations in clock order across three layers. The interleaving *is* the diagnosis: a 200 OK with a broken UI means neither side is individually wrong and the contract between them is. `fault_localization.suspected_layer` says so explicitly, with the evidence IDs that support it and the alternatives it ruled out.

## Activation

- Reporting a bug, filing a ticket, or writing up a defect for any tracker
- A front-end failure whose cause may be in the back end, or vice versa
- An API returning success while the UI breaks — the contract-drift case this is built for
- Turning `qe-browser`, test-failure, or exploratory-session evidence into something fileable
- Needing a defect an agent can act on, not just a human

## Phase 1 — Capture DOM evidence

```bash
node .claude/skills/defect-report/scripts/capture-dom-context.js \
  --url https://staging.example.com/checkout \
  --testid order-summary \
  --out capture.json
```

Resolves the failing element four levels deep, each level more useful than the last:

| Level | Example | Source |
|---|---|---|
| `selector` | `[data-testid="order-summary"] .summary-total` | `vibium map` |
| `dom_path` | `main#checkout-root › section › aside[data-testid=order-summary] › div` | ancestor walk |
| `framework_component` | `CheckoutPage > OrderSummary` | devtools attrs → `data-component` → `data-testid` → `aria-label` |
| `source_file` + `owner` | `src/checkout/OrderSummary.tsx:42`, last author | repo grep + `git log` |

That last row closes DOM → source file → who fixes it, which is what actually shortens time-to-fix. Every component records `detection_method` and `source_basis`, so a reader can tell a devtools-sourced fact from a grep-based guess. `detection_method: "inferred"` means verify it.

Pass `--selector` or `--testid`. Without either, attribution degrades to page-level and the report says so.

**No usable browser?** The script exits 2 with `vibiumUnavailable: true` — the same contract `qe-browser` uses. This covers both cases that leave you without DOM evidence: vibium not installed, and vibium installed but unable to launch a browser (running as root without `--no-sandbox`, a chromedriver/Chrome version mismatch, or a host that cannot reach Chrome for Testing). Both are environment gaps rather than failures, and both mean the same thing to a caller: hand-author `components[]` and `evidence[]` and continue at Phase 2. A genuine page-load failure — connection refused, DNS, timeout — stays exit 1, because that is a real result you need to see.

Browser driving is entirely `qe-browser`'s job; this skill only shapes what comes back. Child stderr is captured rather than inherited, so the JSON envelope on stdout stays parseable even when a caller redirects `2>&1`.

## Phase 2 — Build and validate

```bash
node .claude/skills/defect-report/scripts/build-report.js \
  --report draft.json --capture capture.json --out report.json
```

Assigns stable ids (`C-01`, `EV-01`), computes `offset_ms` from timestamps, derives the dedupe `fingerprint`, and validates against `schemas/defect-report.json`.

**Errors block.** Beyond schema conformance, the validator enforces referential integrity, because a report citing `EV-07` that does not exist is unusable to an agent even when every field is individually valid:

- dangling `evidence_refs`, `ruled_out_by`, `timeline` entries, or `component_ref`
- duplicate component or evidence ids
- a `fault_localization.rationale` citing no evidence at all — an uncited layer verdict is an opinion, not a finding

**Warnings inform** (use `--strict` to make them block): a missing correlation ID on an integration defect, an empty `contract_delta` on an `integration-*` defect, single-layer evidence where cross-layer was needed, a `timeline` that disagrees with the timestamps, a component with no `source_file`, `executable` steps not yet verified as replayable.

### The fingerprint

Derived from stable facts only — component, error class, endpoint with numeric/UUID segments normalised, status, defect type, layer. Timestamps, trace IDs, order numbers and counts are deliberately excluded, so the same defect seen by two people on two days hashes identically. `POST /api/v2/orders/8821` and `/orders/9134` produce the same fingerprint; `/refunds/8821` does not.

## Phase 3 — Redact (blocking)

```bash
node .claude/skills/defect-report/scripts/redact.js --in report.json --write clean.json
```

Filing publishes to an external service where content may be cached or indexed even if later deleted, and a HAR capture routinely carries session cookies and bearer tokens. So this gate is not advisory: with findings and without `--write` or `--acknowledge`, it exits 1 and the report must not be filed.

Catches AWS keys, GitHub/Slack tokens, JWTs, bearer and cookie headers, private keys, connection strings, session ids, `api_key=`-style assignments, card numbers and SSNs (removed outright — masking still leaks prefix and length); emails and public IPs are flagged for a human to judge, not deleted.

Detection runs against the original value for every pattern *before* any replacement, so overlapping patterns cannot hide each other and the audit trail in `provenance.redaction` reflects everything that was actually found.

**It scans the report JSON only.** Attachment *files* are never rewritten — a HAR or log attachment stays `redacted: false` and the script warns. Scrub or drop those separately.

## Phase 4 — Render

```bash
node .claude/skills/defect-report/scripts/render.js --in clean.json --format markdown --content-only
node .claude/skills/defect-report/scripts/render.js --in clean.json --format jira-adf --out desc.json
node .claude/skills/defect-report/scripts/render.js --in clean.json --format github-body
```

Section order is identical across formats — verdict first, then evidence, then what you need to act. `jira-adf` emits a real ADF document (`{version:1, type:"doc", …}`) for `createJiraIssue` with `contentFormat: "adf"`. `github-body` appends the full JSON in a collapsed `<details>`, so the human summary and the machine-readable facts travel in one issue and cannot drift apart. Both warn when approaching the tracker's length cap (Jira 32000, GitHub 65536).

## Phase 5 — File (explicit confirmation only)

Default is a local file under `.aqe/defect-reports/`. Filing to a tracker is outward-facing and effectively irreversible, so it happens only when asked — never as a side effect of generating a report.

**Always dedupe first.** Search the tracker for `fp-<fingerprint>`; on a hit, comment on the existing issue rather than filing a second one. Splitting one defect's evidence across two tickets is exactly what the fingerprint prevents.

Filing goes through MCP tools — `createJiraIssue`, `issue_write` — so this skill holds no credentials and contains no HTTP code. Field mappings, the required discovery step for a new Jira project, and the dedupe queries are in **`references/tracker-adapters.md`**. Read it before the first filing into any project: a project whose Bug type marks Components required will reject the whole call.

Before filing, confirm with the human: tracker, project, issue type, and that redaction ran. Report the returned key and URL.

## Report anatomy

`schemas/defect-report.json` is the contract. The fields that carry most of the weight:

| Field | Why it exists |
|---|---|
| `digest` | ≤1200 chars, read-first. An agent triaging a queue should need nothing else. State the layer verdict and the one fact that proves it |
| `evidence[]` | Every observation with a stable citable id, a `layer`, a time, and a `correlation_id`. Facts only — interpretation belongs in `fault_localization` |
| `timeline` | Evidence ids in clock order across layers. The interleaving is the diagnosis |
| `boundary.contract_delta` | Path-level expected-vs-actual diff. The most common FE/BE bug class deserves a first-class field, not a pasted payload |
| `fault_localization` | The layer verdict as a hypothesis: confidence, cited evidence, alternatives with what ruled them out, and open questions. An honest `unknown` with ruled-out alternatives beats a confident guess |
| `components[]` | DOM → component → source file → owner, each with its detection basis |
| `reproduction.executable` | The steps in `qe-browser` `batch.js` format, making the report replayable rather than merely descriptive |

### Replaying a report

```bash
jq -c '.reproduction.executable.steps' report.json \
  | xargs -0 -I{} node .claude/skills/qe-browser/scripts/batch.js --steps {}
```

Set `verified_replayable: true` only after actually running them. The validator warns while it is false, because an unverified repro is a claim, not a fact.

## Output contract

Every script emits the AQE Tier-3 envelope (`schemas/output.json`) with `operation` set to the phase:

| Exit | Status | Meaning |
|---|---|---|
| 0 | `success` / `partial` | Completed; `partial` carries warnings worth reading |
| 1 | `failed` | Validation errors, or redaction findings left unresolved |
| 2 | `skipped` | Browser engine unavailable (`vibiumUnavailable: true`) — environment, not defect |

## Related skills

Deliberately non-overlapping — reach for the right one:

- **`bug-reporting-excellence`** — writing quality: the title formula this skill's `title` follows, and the severity rubric its `severity` enum matches. Consult it for the judgement calls; this skill handles the structured artifact and the filing.
- **`qe-browser`** — all browser driving. Phase 1 is a thin shaper over it.
- **`qe-root-cause-analyzer`** / **`qe-defect-intelligence`** — 5-whys, fishbone, prediction across defect history. This skill produces their input; it states a layer hypothesis, not a full RCA.
- **`test-failure-investigator`** — for a failing test rather than a product defect.
- **`contract-testing`** — to stop contract drift recurring once a `contract_delta` has named it.
