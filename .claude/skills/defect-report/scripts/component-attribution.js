'use strict';
/**
 * Component attribution for capture-dom-context.js: turn probed page facts into
 * the `components[]` and `evidence[]` records of schemas/defect-report.json.
 *
 * Every record says how it was derived — detection_method, source_basis — so a
 * reader can tell a framework-sourced fact from a grep-based guess.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const lib = require('./lib.js');

/**
 * Resolve a component name from an element record, most trustworthy source
 * first. detection_method is reported alongside so a reader can tell a
 * devtools-sourced name from an inference.
 */
function resolveComponentName(el) {
  const attrs = el.attributes || el.attrs || {};
  const candidates = [
    ['data-component', attrs['data-component']],
    ['data-component', attrs['data-component-name']],
    ['devtools-attribute', attrs['data-testid-component']],
    ['data-testid', attrs['data-testid'] || attrs['data-test-id'] || attrs['data-test']],
    ['aria-label', attrs['aria-label']],
  ];
  for (const [method, value] of candidates) {
    if (value) return { name: String(value), method };
  }
  if (el.role) return { name: `${el.tag || 'element'}[role=${el.role}]`, method: 'aria-label' };
  return { name: el.tag ? String(el.tag) : 'unknown', method: 'inferred' };
}

/**
 * Map a component name or testid back to the source file that defines it.
 * grep-based and therefore best-effort: source_basis records how the match was
 * made so a wrong guess is auditable rather than silently authoritative.
 */
function resolveSourceFile(name, repoRoot) {
  if (!name || name === 'unknown') return null;
  const bare = name.replace(/[^A-Za-z0-9_-]/g, '');
  if (bare.length < 3) return null;

  const attempts = [
    { pattern: `(function|const|class)\\s+${bare}\\b`, basis: `declaration of ${bare}` },
    { pattern: `data-testid=["']${bare}["']`, basis: `data-testid="${bare}" literal` },
    { pattern: `\\b${bare}\\b`, basis: `name occurrence ${bare}` },
  ];

  for (const { pattern, basis } of attempts) {
    const res = spawnSync(
      'grep',
      ['-rEl', '--include=*.tsx', '--include=*.jsx', '--include=*.ts', '--include=*.js',
       '--include=*.vue', '--include=*.svelte', '--include=*.html',
       '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git',
       pattern, repoRoot],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 }
    );
    if (res.status === 0) {
      const hits = String(res.stdout).trim().split('\n').filter(Boolean);
      if (hits.length > 0 && hits.length <= 5) {
        return { file: path.relative(repoRoot, hits[0]) || hits[0], basis, ambiguous: hits.length > 1 };
      }
    }
  }
  return null;
}

/** Most frequent recent author of a file — a triage hint, never an assignment. */
function resolveOwner(file, repoRoot) {
  if (!file) return null;
  const res = spawnSync('git', ['log', '-n', '20', '--format=%an', '--', file], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) return null;
  const counts = {};
  for (const author of String(res.stdout).trim().split('\n').filter(Boolean)) {
    counts[author] = (counts[author] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : null;
}


/**
 * Source-file lookup greps the local repo, which is only meaningful when that
 * repo is the app being captured. Against a third-party page, a component
 * called `TodoItem` or `Delete` would "resolve" to whatever unrelated file in
 * the current checkout happens to contain the word — confidently wrong. So it
 * runs only for local pages or when --repo-root names the app's repo.
 */
function shouldResolveSource(url, args) {
  if (args['repo-root']) return true;
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'file:' || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname) || hostname.endsWith('.local');
  } catch (_err) {
    return false;
  }
}

/** A component record for the element the defect manifests on. */
function targetComponent(t, framework, ctx) {
  const fromAttrs = resolveComponentName({ attributes: t.attributes, role: t.role, tag: t.tag });
  const react = Array.isArray(t.react) && t.react.length ? t.react : null;
  const name = react ? react.join(' > ') : fromAttrs.name;
  const source = ctx.resolveSource ? resolveSourceFile(react ? react[react.length - 1] : fromAttrs.name, ctx.repoRoot) : null;
  if (source?.ambiguous) ctx.warnings.push(`source_file for ${name} matched multiple files; verify before trusting it.`);
  const owner = source ? resolveOwner(source.file, ctx.repoRoot) : null;
  const a = t.attributes || {};
  return {
    id: lib.componentId(0),
    role_in_defect: 'failing',
    selector: t.selector,
    dom_path: t.path,
    framework_component: name,
    framework,
    detection_method: react ? 'devtools-attribute' : fromAttrs.method,
    ...(a['data-testid'] ? { testid: a['data-testid'] } : {}),
    aria: {
      ...(t.role ? { role: t.role } : {}),
      ...(a['aria-label'] ? { label: a['aria-label'] } : {}),
      ...(a['aria-describedby'] ? { described_by: a['aria-describedby'] } : {}),
    },
    ...(t.text ? { text_content: t.text } : {}),
    bounding_box: t.box,
    state_snapshot: t.state,
    ...(source ? { source_file: source.file, source_basis: source.basis } : {}),
    ...(owner ? { owner } : {}),
  };
}

/** The nearest ancestor carrying a test id or component name, as context. */
function containerComponent(c, framework) {
  return {
    id: lib.componentId(1),
    role_in_defect: 'container',
    selector: c.selector,
    framework_component: c.component || c.testid,
    framework,
    detection_method: c.component ? 'data-component' : 'data-testid',
    ...(c.testid ? { testid: c.testid } : {}),
    ...(c.role ? { aria: { role: c.role } } : {}),
  };
}

/** Observed state of the target, including the CSS rules governing it. */
function stateEvidence(t) {
  const s = t.state;
  const facts = [
    `display ${s.display}`,
    `${t.box.width}x${t.box.height}px`,
    s.in_tab_order ? 'in the tab order' : 'not in the tab order',
  ];
  if (s.hidden_by) facts.push(`hidden by ${s.hidden_by}`);
  const rules = (t.rules || []).map((r) => `${r.selector} { ${r.declarations} }  [applies ${r.applies_on}]  ${r.stylesheet}`);
  return {
    id: lib.evidenceId(0),
    layer: 'ui',
    kind: 'dom-state',
    summary: `${t.selector}: ${facts.join(', ')}`.slice(0, 600),
    timestamp: new Date().toISOString(),
    component_ref: lib.componentId(0),
    detail: JSON.stringify({ state: s, governing_rules: rules }, null, 2).slice(0, 20000),
    source: 'capture-dom-context (eval probe)',
  };
}

module.exports = {
  resolveComponentName,
  shouldResolveSource,
  targetComponent,
  containerComponent,
  stateEvidence,
};
