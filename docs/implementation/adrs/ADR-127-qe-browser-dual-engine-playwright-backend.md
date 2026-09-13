# ADR-127: Dual-engine qe-browser — Playwright as an opt-in backend

| Field | Value |
|-------|-------|
| **Decision ID** | ADR-127 |
| **Status** | Implemented |
| **Date** | 2026-09-13 |
| **Amends** | ADR-091 (qe-browser fleet skill with Vibium as browser engine) |
| **Author** | QE Fleet |
| **Review Cadence** | On Vibium or Playwright major version bump |
| **Analysis Method** | Read of the existing engine seam, live end-to-end run of all five QE primitives against a real Chromium on a proxy-restricted host |

---

## WH(Y) Decision Statement

**In the context of** ADR-091's choice of Vibium as the fleet's single browser engine, and its explicit decision not to build a runtime fallback — a decision whose stated basis was that a second engine would mean re-implementing the QE primitives,

**facing** the consequence ADR-091 itself predicted ("Vibium install fails → all 11 migrated skills degrade to documentation-only... users who cannot install Vibium (air-gapped, restricted npm registries) must install it manually"), now observed in practice: Vibium lazily downloads Chrome for Testing from `googlechromelabs.github.io`, which proxy-restricted and air-gapped hosts cannot reach, leaving every browser skill inert,

**we decided** to add Playwright as an opt-in second backend behind the engine seam that already exists, selected explicitly via `QE_BROWSER_ENGINE` and defaulting to Vibium,

**to achieve** a working browser engine on hosts where Vibium cannot run, without changing behaviour for anyone who does not opt in,

**accepting** a second engine's maintenance cost and the renderer-specific baseline problem described below.

## The premise that turned out to be wrong

ADR-091 declined a fallback because "doing so correctly would require re-implementing the QE primitives on top of Playwright." Measured against the code, that is not what a second engine costs.

All five primitives — `assert.js`, `batch.js`, `visual-diff.js`, `check-injection.js`, `intent-score.js`, 1,538 lines in total — reach the browser through exactly one file, `lib/vibium.js`, and they use a vocabulary of roughly fourteen argv verbs: `go, map, click, fill, type, press, wait, screenshot, source, console, network, eval, storage, close`.

A second engine therefore does not re-implement the primitives. It implements those verbs. The primitives are untouched by this ADR.

## Decision

1. **`lib/engine.js`** selects a backend from `QE_BROWSER_ENGINE` (`vibium` | `playwright`), defaulting to `vibium`.
2. **`lib/engines/vibium.js`** is a verbatim extraction of the previous `spawnSync` call, so the default path is unchanged.
3. **`lib/engines/playwright.js`** implements the same argv vocabulary and returns the same `{ status, stdout, stderr }` shape.
4. **`lib/vibium.js`** keeps its entire public export surface and delegates to the selected backend. No caller changes.

### Session model

Vibium keeps a background daemon, so `go`, then `map`, then `click @e1` are separate processes sharing one session. Playwright has no such daemon, so the backend launches a **detached Chrome with a CDP port** and reconnects to it via `connectOverCDP` on each invocation, persisting the endpoint and the `@ref` map in `~/.cache/qe-browser/playwright-session.json`.

CDP rather than Playwright's own `launchServer`/`connect`: for a connected browser, `browser.close()` clears the contexts that connection created, so the page would be destroyed the instant a command finished and the next command would see a blank tab. Over CDP the browser is an independent process and pages outlive client connections. This was found by running it, not by reading docs.

### No automatic fallback

Selection is explicit. There is deliberately no "try Vibium, fall back to Playwright": visual-diff baselines are renderer-specific, and an engine that changes underneath a suite produces false visual regressions. An engine change should be a decision someone made, not one that happened to them.

## Consequences

**Positive**
- Browser skills work on proxy-restricted and air-gapped hosts.
- Zero behaviour change by default: `QE_BROWSER_ENGINE` unset means the Vibium path, byte-for-byte.
- `defect-report` now routes through this layer instead of spawning a browser binary itself, so it inherits engine selection with no engine-aware code of its own.
- Element-scoped screenshots work on Playwright — a capability Vibium v26.3.x lacks, previously a hard `throw` in `visual-diff.js`, now branched by engine.

**Negative / risks**
- **Renderer-specific baselines.** Vibium's Chrome and Playwright's Chromium differ at the pixel level from font rasterisation and compositing alone. Mitigated: each baseline records the engine that produced it, and a cross-engine comparison is refused with an actionable message rather than reported as a regression. Baselines predating this ADR carry no metadata and are still accepted, so nothing existing breaks.
- **Two engines to maintain.** A new argv verb must land in both backends. The verb set has been stable and is small.
- **Playwright's install footprint** is the ~300MB ADR-091 moved away from. It is opt-in and not required by `aqe init`, so the default footprint is unchanged.

## Verification

All five primitives were exercised against a real Chromium driving a live page with a genuine front-end/back-end contract defect:

| Primitive | Result on Playwright backend |
|---|---|
| `assert.js` | 4 positive checks pass; a knowingly false claim correctly fails (exit 1) |
| `batch.js` | 3-step flow passes; a following `no_console_errors` assert correctly fails on the real page error |
| `visual-diff.js` | baseline created, re-compare similarity 1.0000, element-scoped capture works |
| `check-injection.js` | scan completes, status success |
| `intent-score.js` | `primary_cta` scores the real button 0.35; correctly returns no candidates once that button is disabled |

The Vibium path could not be executed on the verification host — the failure this ADR exists to address — but its unavailability contract was confirmed to still fire through the new layer (`status: skipped`, `vibiumUnavailable: true`, exit 2). **The Vibium backend is an unmodified extraction and must be re-verified on a host where Vibium runs before this ADR's implementation gate is considered cleared.**

### A defect found during verification

The Playwright backend initially returned console output as `{ messages: [...] }`, while `assert.js` reads a bare array or `{ entries: [...] }`. The mismatch did not error — it read as an empty list, so `no_console_errors` **passed on a page with an uncaught TypeError**. A silent false PASS is the worst failure mode available to test tooling.

Fixed by emitting every field name the primitives read, and by normalising defensively on the consumer side. The same latent bug existed in `defect-report`'s capture script, which read `.messages || .logs` and would have captured zero console evidence against real Vibium.

This is worth recording because it is the same defect class `defect-report` was built to diagnose: two components, each correct on its own terms, disagreeing about a contract — and failing silently rather than loudly.
