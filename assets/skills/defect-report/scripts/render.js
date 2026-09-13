#!/usr/bin/env node
'use strict';
/**
 * render.js — project one canonical report into the three shapes it needs.
 *
 *   markdown     human reading, and the GitHub issue body's base
 *   jira-adf     Atlassian Document Format, for createJiraIssue description
 *   github-body  markdown plus a collapsed machine-readable block
 *
 * All three derive from the same JSON, so a human and an agent never read
 * diverging accounts of the same defect. Section order is identical across
 * formats: verdict first, then evidence, then everything needed to act.
 *
 * Usage:
 *   node render.js --in <report.json> --format markdown|jira-adf|github-body [--out <file>]
 *   node render.js --in <report.json> --format markdown --content-only
 */

const fs = require('fs');
const lib = require('./lib.js');

const OP = 'render';
const FORMATS = ['markdown', 'jira-adf', 'github-body'];

// ---------------------------------------------------------------------------
// Shared section content — computed once, emitted per format
// ---------------------------------------------------------------------------

const LAYER_LABEL = {
  ui: 'UI', network: 'NET', backend: 'BE', data: 'DATA', build: 'BUILD', config: 'CFG',
};

function offsetLabel(e) {
  if (e.offset_ms === undefined) return '—';
  return `+${(e.offset_ms / 1000).toFixed(2)}s`;
}

/** Evidence in timeline order, falling back to declaration order. */
function orderedEvidence(report) {
  const byId = new Map((report.evidence || []).map((e) => [e.id, e]));
  const ordered = (report.timeline || []).map((id) => byId.get(id)).filter(Boolean);
  for (const e of report.evidence || []) if (!ordered.includes(e)) ordered.push(e);
  return ordered;
}

function componentLine(c) {
  const bits = [c.framework_component || '(unnamed)'];
  if (c.role_in_defect) bits.push(`role: ${c.role_in_defect}`);
  if (c.source_file) bits.push(`source: ${c.source_file}`);
  else bits.push('source: unresolved');
  if (c.detection_method === 'inferred') bits.push('name inferred — verify');
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(report, { forGithub = false } = {}) {
  const c = report.classification;
  const fl = report.fault_localization;
  const env = report.environment;
  const out = [];

  out.push(`# ${report.title}`, '');
  out.push(
    `> **${c.severity.toUpperCase()}**${c.priority ? ` · ${c.priority}` : ''} · ${c.defect_type} · reproduces ${c.reliability}${c.reproduction_rate ? ` (${c.reproduction_rate})` : ''}`,
    `> Suspected layer: **${fl.suspected_layer}** (${fl.confidence} confidence) · fingerprint \`${report.fingerprint}\``,
    ''
  );

  out.push('## Summary', '', report.digest, '');

  out.push('## Verdict', '', fl.rationale, '');
  if (fl.alternatives?.length) {
    out.push('**Ruled out:**', '');
    for (const alt of fl.alternatives) {
      const refs = alt.ruled_out_by?.length ? ` _(${alt.ruled_out_by.join(', ')})_` : '';
      out.push(`- **${alt.layer}** — ${alt.why_less_likely}${refs}`);
    }
    out.push('');
  }
  if (fl.open_questions?.length) {
    out.push('**Open questions:**', '');
    for (const q of fl.open_questions) out.push(`- ${q}`);
    out.push('');
  }

  out.push('## Expected vs actual', '');
  out.push(`**Expected.** ${report.expected}`, '');
  out.push(`**Actual.** ${report.actual}`, '');

  if (report.boundary?.contract_delta?.diffs?.length) {
    const cd = report.boundary.contract_delta;
    out.push('## Contract mismatch', '');
    if (cd.contract_source) out.push(`Contract: \`${cd.contract_source}\``, '');
    out.push('| Path | Problem | Expected | Actual | Consumer impact |', '|---|---|---|---|---|');
    for (const d of cd.diffs) {
      out.push(
        `| \`${d.path}\` | ${d.kind} | ${d.expected || '—'} | ${d.actual || '—'} | ${d.consumer_impact || '—'} |`
      );
    }
    out.push('');
  }

  if (report.boundary?.request) {
    const r = report.boundary.request;
    out.push('## Boundary', '');
    out.push(`\`${r.method} ${r.url}\` → **${r.status ?? 'no response'}**${r.duration_ms !== undefined ? ` in ${r.duration_ms}ms` : ''}${r.service ? ` · service \`${r.service}\`` : ''}`, '');
    if (report.boundary.correlation_id) out.push(`Correlation ID: \`${report.boundary.correlation_id}\``, '');
  }

  out.push('## Components (from DOM)', '');
  for (const comp of report.components || []) {
    out.push(`**${comp.id}** — ${componentLine(comp)}`);
    out.push(`- Selector: \`${comp.selector}\``);
    if (comp.dom_path?.length) {
      const path = comp.dom_path
        .map((n) => n.tag + (n.id ? `#${n.id}` : '') + (n.testid ? `[data-testid=${n.testid}]` : ''))
        .join(' › ');
      out.push(`- DOM path: \`${path}\``);
    }
    if (comp.framework) out.push(`- Framework: ${comp.framework} (detected via ${comp.detection_method || 'unknown'})`);
    if (comp.state_snapshot && Object.keys(comp.state_snapshot).length) {
      out.push(`- State at failure: \`${JSON.stringify(comp.state_snapshot)}\``);
    }
    if (comp.owner) out.push(`- Recent author of source: ${comp.owner}`);
    out.push('');
  }

  out.push('## Evidence timeline', '');
  out.push('| ID | At | Layer | Observation |', '|---|---|---|---|');
  for (const e of orderedEvidence(report)) {
    out.push(`| ${e.id} | ${offsetLabel(e)} | ${LAYER_LABEL[e.layer] || e.layer} | ${escapeCell(e.summary)} |`);
  }
  out.push('');

  const detailed = orderedEvidence(report).filter((e) => e.detail);
  if (detailed.length) {
    out.push('<details><summary>Evidence detail</summary>', '');
    for (const e of detailed) {
      out.push(`**${e.id}** (${e.layer}/${e.kind})${e.correlation_id ? ` · trace \`${e.correlation_id}\`` : ''}`, '');
      out.push('```', e.detail, '```', '');
    }
    out.push('</details>', '');
  }

  out.push('## Reproduction', '');
  if (report.reproduction.preconditions?.length) {
    out.push('**Preconditions:**', '');
    for (const p of report.reproduction.preconditions) out.push(`- ${p}`);
    out.push('');
  }
  report.reproduction.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  const ex = report.reproduction.executable;
  if (ex?.steps?.length) {
    const verified = ex.verified_replayable ? 'verified replayable' : 'NOT yet verified — run before trusting';
    out.push(`**Replay (${ex.engine}, ${verified}):**`, '');
    if (ex.engine === 'qe-browser') {
      out.push('```bash', `jq -c '.reproduction.executable.steps' report.json \\`, '  | xargs -0 -I{} node .claude/skills/qe-browser/scripts/batch.js --steps {}', '```', '');
    }
    out.push('```json', JSON.stringify(ex.steps, null, 2), '```', '');
  }

  out.push('## Environment', '');
  out.push('| | |', '|---|---|');
  const envRows = [
    ['Tier', env.tier], ['URL', env.url], ['App', env.app_version], ['Build', env.build_sha],
    ['Backend', env.backend_version], ['Browser', env.browser], ['Viewport', env.viewport],
    ['OS', env.os], ['Device', env.device], ['Locale', env.locale], ['Tenant', env.tenant],
  ].filter(([, v]) => v);
  for (const [k, v] of envRows) out.push(`| ${k} | ${v} |`);
  if (env.feature_flags && Object.keys(env.feature_flags).length) {
    out.push(`| Feature flags | ${Object.entries(env.feature_flags).map(([k, v]) => `${k}=${v}`).join(', ')} |`);
  }
  if (c.regression_since) out.push(`| Last known good | ${c.regression_since} |`);
  out.push('');

  out.push('## Impact', '', report.impact.description, '');
  const impactRows = [
    ['Users affected', report.impact.users_affected],
    ['Business impact', report.impact.business_impact],
    ['Workaround', report.impact.workaround],
    ['Occurrences', report.impact.occurrences],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  for (const [k, v] of impactRows) out.push(`- **${k}:** ${v}`);
  out.push('');

  if (report.triage) {
    const t = report.triage;
    out.push('## Triage', '');
    if (t.suggested_team) out.push(`- Suggested team: ${t.suggested_team}`);
    if (t.suggested_assignee) out.push(`- Suggested assignee: ${t.suggested_assignee}${t.assignee_basis ? ` _(${t.assignee_basis})_` : ''}`);
    if (t.duplicate_of) out.push(`- **Possible duplicate of ${t.duplicate_of}**`);
    if (t.linked_tests?.length) {
      out.push('- Tests that should have caught this:');
      for (const lt of t.linked_tests) out.push(`  - ${lt}`);
    }
    out.push('');
  }

  if (report.attachments?.length) {
    out.push('## Attachments', '');
    for (const a of report.attachments) {
      out.push(`- \`${a.path}\` (${a.kind})${a.description ? ` — ${a.description}` : ''}${a.redacted ? '' : ' **[not redacted]**'}`);
    }
    out.push('');
  }

  const p = report.provenance;
  out.push('---', '');
  out.push(
    `_Generated by ${p.generated_by} at ${p.generated_at}. Fingerprint \`${report.fingerprint}\`. ` +
      `Redaction ${p.redaction.applied ? `applied (${p.redaction.findings_removed || 0} removed)` : '**not applied**'}._`
  );

  if (forGithub) {
    out.push('', '<details><summary>Machine-readable report (defect-report schema 1.0.0)</summary>', '');
    out.push('```json', JSON.stringify(report, null, 2), '```', '', '</details>');
  }

  return out.join('\n');
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Jira ADF
// ---------------------------------------------------------------------------

const text = (t, marks) => ({ type: 'text', text: String(t), ...(marks ? { marks } : {}) });
const strong = (t) => text(t, [{ type: 'strong' }]);
const code = (t) => text(t, [{ type: 'code' }]);
const para = (...content) => ({ type: 'paragraph', content: content.filter(Boolean) });
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const codeBlock = (t, language) => ({
  type: 'codeBlock',
  ...(language ? { attrs: { language } } : {}),
  content: [text(t)],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [Array.isArray(i) ? para(...i) : para(text(i))] })),
});
const ordered = (items) => ({
  type: 'orderedList',
  content: items.map((i) => ({ type: 'listItem', content: [para(text(i))] })),
});
const panel = (type, content) => ({ type: 'panel', attrs: { panelType: type }, content });

function cell(content, header = false) {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    attrs: {},
    content: [Array.isArray(content) ? para(...content) : para(text(content))],
  };
}
function table(headers, rows) {
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      { type: 'tableRow', content: headers.map((h) => cell(h, true)) },
      ...rows.map((r) => ({ type: 'tableRow', content: r.map((v) => cell(v)) })),
    ],
  };
}

function renderAdf(report) {
  const c = report.classification;
  const fl = report.fault_localization;
  const env = report.environment;
  const content = [];

  const panelType = c.severity === 'critical' || c.severity === 'high' ? 'error' : 'warning';
  content.push(
    panel(panelType, [
      para(
        strong(`${c.severity.toUpperCase()}${c.priority ? ` · ${c.priority}` : ''}`),
        text(` · ${c.defect_type} · reproduces ${c.reliability}`)
      ),
      para(text('Suspected layer: '), strong(fl.suspected_layer), text(` (${fl.confidence} confidence) · fingerprint `), code(report.fingerprint)),
    ])
  );

  content.push(heading(2, 'Summary'), para(text(report.digest)));

  content.push(heading(2, 'Verdict'), para(text(fl.rationale)));
  if (fl.alternatives?.length) {
    content.push(para(strong('Ruled out:')));
    content.push(bullets(fl.alternatives.map((a) => [strong(a.layer), text(` — ${a.why_less_likely}`), ...(a.ruled_out_by?.length ? [text(` (${a.ruled_out_by.join(', ')})`)] : [])])));
  }
  if (fl.open_questions?.length) {
    content.push(para(strong('Open questions:')), bullets(fl.open_questions));
  }

  content.push(heading(2, 'Expected vs actual'));
  content.push(para(strong('Expected. '), text(report.expected)));
  content.push(para(strong('Actual. '), text(report.actual)));

  const cd = report.boundary?.contract_delta;
  if (cd?.diffs?.length) {
    content.push(heading(2, 'Contract mismatch'));
    if (cd.contract_source) content.push(para(text('Contract: '), code(cd.contract_source)));
    content.push(
      table(
        ['Path', 'Problem', 'Expected', 'Actual', 'Consumer impact'],
        cd.diffs.map((d) => [d.path, d.kind, d.expected || '—', d.actual || '—', d.consumer_impact || '—'])
      )
    );
  }

  if (report.boundary?.request) {
    const r = report.boundary.request;
    content.push(heading(2, 'Boundary'));
    content.push(
      para(
        code(`${r.method} ${r.url}`),
        text(' → '),
        strong(String(r.status ?? 'no response')),
        text(r.duration_ms !== undefined ? ` in ${r.duration_ms}ms` : ''),
        r.service ? text(` · service ${r.service}`) : null
      )
    );
    if (report.boundary.correlation_id) {
      content.push(para(text('Correlation ID: '), code(report.boundary.correlation_id)));
    }
  }

  content.push(heading(2, 'Components (from DOM)'));
  content.push(
    table(
      ['ID', 'Component', 'Role', 'Selector', 'Source'],
      (report.components || []).map((comp) => [
        comp.id,
        comp.framework_component || '(unnamed)',
        comp.role_in_defect || '—',
        comp.selector,
        comp.source_file || 'unresolved',
      ])
    )
  );

  content.push(heading(2, 'Evidence timeline'));
  content.push(
    table(
      ['ID', 'At', 'Layer', 'Observation'],
      orderedEvidence(report).map((e) => [e.id, offsetLabel(e), LAYER_LABEL[e.layer] || e.layer, e.summary])
    )
  );
  for (const e of orderedEvidence(report).filter((x) => x.detail)) {
    content.push(para(strong(`${e.id}`), text(` (${e.layer}/${e.kind})`)), codeBlock(e.detail));
  }

  content.push(heading(2, 'Reproduction'));
  if (report.reproduction.preconditions?.length) {
    content.push(para(strong('Preconditions:')), bullets(report.reproduction.preconditions));
  }
  content.push(ordered(report.reproduction.steps));
  const ex = report.reproduction.executable;
  if (ex?.steps?.length) {
    content.push(
      para(
        strong(`Replay (${ex.engine})`),
        text(ex.verified_replayable ? ' — verified replayable' : ' — NOT yet verified, run before trusting')
      ),
      codeBlock(JSON.stringify(ex.steps, null, 2), 'json')
    );
  }

  content.push(heading(2, 'Environment'));
  const envRows = [
    ['Tier', env.tier], ['URL', env.url], ['App', env.app_version], ['Build', env.build_sha],
    ['Backend', env.backend_version], ['Browser', env.browser], ['Viewport', env.viewport],
    ['OS', env.os], ['Locale', env.locale], ['Tenant', env.tenant],
    ['Feature flags', env.feature_flags ? Object.entries(env.feature_flags).map(([k, v]) => `${k}=${v}`).join(', ') : ''],
    ['Last known good', c.regression_since],
  ].filter(([, v]) => v);
  content.push(table(['Field', 'Value'], envRows));

  content.push(heading(2, 'Impact'), para(text(report.impact.description)));
  const impactItems = [
    report.impact.users_affected ? `Users affected: ${report.impact.users_affected}` : null,
    report.impact.business_impact ? `Business impact: ${report.impact.business_impact}` : null,
    report.impact.workaround ? `Workaround: ${report.impact.workaround}` : null,
  ].filter(Boolean);
  if (impactItems.length) content.push(bullets(impactItems));

  if (report.attachments?.length) {
    content.push(heading(2, 'Attachments'));
    content.push(bullets(report.attachments.map((a) => `${a.path} (${a.kind})${a.redacted ? '' : ' [not redacted]'}`)));
  }

  content.push(
    panel('note', [
      para(
        text(`Generated by ${report.provenance.generated_by} at ${report.provenance.generated_at}. Fingerprint `),
        code(report.fingerprint),
        text(`. Redaction ${report.provenance.redaction.applied ? 'applied' : 'NOT applied'}.`)
      ),
    ])
  );

  return { version: 1, type: 'doc', content };
}

// ---------------------------------------------------------------------------

function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const started = Date.now();
  const format = args.format || 'markdown';

  if (!args.in) lib.fail(OP, 'Missing required --in <report.json>.', ['node render.js --in /tmp/report.json --format markdown']);
  if (!FORMATS.includes(format)) lib.fail(OP, `Unknown --format "${format}". Valid: ${FORMATS.join(', ')}.`);
  if (!fs.existsSync(args.in)) lib.fail(OP, `Input not found: ${args.in}`);

  let report;
  try {
    report = lib.extractReport(lib.readJson(args.in));
  } catch (err) {
    lib.fail(OP, `Could not parse ${args.in}: ${err.message}`);
  }
  if (!report) lib.fail(OP, `${args.in} does not contain a defect report (expected schema_version and fingerprint).`);

  let content;
  if (format === 'jira-adf') content = JSON.stringify(renderAdf(report), null, 2);
  else content = renderMarkdown(report, { forGithub: format === 'github-body' });

  if (args.out) {
    fs.mkdirSync(require('path').dirname(require('path').resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, content.endsWith('\n') ? content : content + '\n');
  }

  // --content-only prints the rendering alone, for piping into a tracker call.
  if (args['content-only']) {
    process.stdout.write(content + '\n');
    process.exit(0);
  }

  const warnings = [];
  if (!report.provenance.redaction.applied) {
    warnings.push('Redaction has not been applied to this report. Run redact.js before filing it anywhere external.');
  }
  if (format === 'github-body' && content.length > 60000) {
    warnings.push(`Body is ${content.length} chars; GitHub caps issue bodies at 65536. Move evidence detail to an attachment.`);
  }
  if (format === 'jira-adf' && content.length > 32000) {
    warnings.push(`ADF document is ${content.length} chars, which may exceed the Jira description limit. Trim evidence detail or attach it instead.`);
  }

  lib.emit(
    lib.envelope(
      OP,
      warnings.length ? 'partial' : 'success',
      {
        summary: `Rendered the defect report as ${format} (${content.length} characters)${args.out ? `, written to ${args.out}` : ''}.`,
        rendered: { format, content, characters: content.length },
        warnings,
      },
      { metadata: { executionTimeMs: Date.now() - started } }
    )
  );
}

main();
