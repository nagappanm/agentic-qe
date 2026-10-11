'use strict';
/**
 * Engine-agnostic page probes for capture-dom-context.js.
 *
 * Everything here runs through `eval`, the one command every engine supports
 * with a stable contract (JavaScript in, JSON out). Capture used to depend on
 * engine-specific commands — `map`, `source`, `console`, `network` — and those
 * drift: Vibium v26.8 returns `map` as plain text lines, renamed `source` to
 * `html`, and dropped `console` and `network` entirely. Against that release
 * capture silently returned zero components and zero evidence.
 *
 * Each probe takes `run(args, { input })`, the caller's engine wrapper, which
 * returns stdout or throws. Probes never throw: they return null or an explicit
 * `unsupported` marker, so the caller can say *why* evidence is missing rather
 * than implying nothing happened.
 */

/** Evaluate a page script and return its JSON-decoded value, or null. */
function evalJson(run, script) {
  let stdout;
  try {
    stdout = run(['eval', '--stdin', '--json'], { input: `JSON.stringify((${script}))` });
  } catch (_err) {
    return null;
  }
  try {
    const payload = JSON.parse(String(stdout).trim());
    const value = payload && Object.prototype.hasOwnProperty.call(payload, 'result') ? payload.result : payload;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_err) {
    return null;
  }
}

/**
 * Resolve the failing element in the page: identity, DOM path, ARIA, geometry,
 * focusability, and the stylesheet rules that govern its visibility.
 *
 * The visibility rules are the point. A UI defect is very often "the element
 * exists but cannot be seen or reached", and the rule responsible — say
 * `.row .delete { display: none }` revealed only by `.row:hover .delete` — is
 * the root cause. Recording it turns "it's hidden" into "it's hidden by this".
 */
function probeTarget(run, { selector, testid }) {
  const params = JSON.stringify({ selector: selector || null, testid: testid || null });
  return evalJson(run, `(function (p) {
    var q = p.selector || ('[data-testid="' + CSS.escape(p.testid) + '"]');
    var all; try { all = document.querySelectorAll(q); } catch (e) { return { found: false, error: 'invalid selector: ' + q }; }
    var el = all[0];
    if (!el) return { found: false, count: 0, query: q };

    var node = function (n) {
      var o = { tag: n.tagName.toLowerCase() };
      if (n.id) o.id = n.id;
      if (n.classList.length) o.classes = Array.prototype.slice.call(n.classList, 0, 30);
      if (n.getAttribute('role')) o.role = n.getAttribute('role');
      if (n.dataset && n.dataset.testid) o.testid = n.dataset.testid;
      if (n.dataset && n.dataset.component) o.component = n.dataset.component;
      return o;
    };
    var path = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) path.unshift(node(n));

    var container = null;
    for (var c = el.parentElement; c; c = c.parentElement) {
      if (c.dataset && (c.dataset.testid || c.dataset.component)) {
        container = node(c);
        container.selector = c.dataset.testid ? '[data-testid="' + c.dataset.testid + '"]' : '[data-component="' + c.dataset.component + '"]';
        break;
      }
    }

    var own = el.dataset && el.dataset.testid ? '[data-testid="' + el.dataset.testid + '"]'
      : container ? container.selector + ' ' + el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '')
      : q;

    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value.slice(0, 200);

    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    var hiddenBy = null;
    for (var h = el; h && h.nodeType === 1; h = h.parentElement) {
      var hs = getComputedStyle(h);
      if (hs.display === 'none') { hiddenBy = { reason: 'display:none', on: h === el ? 'self' : node(h) }; break; }
      if (hs.visibility === 'hidden') { hiddenBy = { reason: 'visibility:hidden', on: h === el ? 'self' : node(h) }; break; }
    }
    var focusableTag = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) || el.hasAttribute('tabindex');
    var inTabOrder = focusableTag && el.tabIndex >= 0 && !el.disabled && !hiddenBy && !el.closest('[inert]');

    var STATE = /:(hover|focus-within|focus-visible|focus|active)\\b/;
    var rules = [], props = ['display', 'visibility', 'opacity', 'pointer-events'];
    outer: for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s], list;
      try { list = sheet.cssRules; } catch (e) { continue; }
      for (var k = 0; k < list.length; k++) {
        var ru = list[k];
        if (!ru.selectorText || !ru.style) continue;
        var sets = props.filter(function (pp) { return ru.style.getPropertyValue(pp); });
        if (!sets.length) continue;
        var parts = ru.selectorText.split(',');
        for (var j = 0; j < parts.length; j++) {
          var sel = parts[j].trim(), m = false;
          try { m = el.matches(sel.replace(new RegExp(STATE.source, 'g'), '')); } catch (e) {}
          if (!m) continue;
          var st = sel.match(STATE);
          rules.push({
            selector: sel,
            declarations: sets.map(function (pp) { return pp + ': ' + ru.style.getPropertyValue(pp); }).join('; '),
            applies_on: st ? ':' + st[1] : 'always',
            stylesheet: sheet.href || 'inline'
          });
          if (rules.length >= 12) break outer;
          break;
        }
      }
    }

    // React: walk the fiber from this DOM node up to its owning components.
    // React 17+ keys it __reactFiber$, React 16 __reactInternalInstance$ (React
    // 15's object has no .return, so the walk simply stops). Production builds
    // minify names, so only keep names that look authored.
    var react = [];
    var fk = Object.keys(el).filter(function (key) {
      return key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0;
    })[0];
    if (fk) {
      for (var f = el[fk]; f && react.length < 6; f = f.return) {
        var t = f.elementType || f.type, nm = t && (t.displayName || t.name);
        if (typeof t !== 'string' && nm && /^[A-Z][A-Za-z0-9]{2,}$/.test(nm) && react.indexOf(nm) < 0) react.push(nm);
      }
      react.reverse();
    }

    var IMPLICIT = { BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', LI: 'listitem', UL: 'list', NAV: 'navigation' };
    var role = el.getAttribute('role') || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio' }[el.type] || 'textbox') : IMPLICIT[el.tagName]) || null;

    return {
      found: true, count: all.length, query: q, selector: own, tag: el.tagName.toLowerCase(),
      attributes: attrs, role: role, text: (el.innerText || el.textContent || '').trim().slice(0, 400),
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      state: {
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        disabled: el.disabled === true, tabIndex: el.tabIndex, in_tab_order: inTabOrder,
        hidden_by: hiddenBy ? hiddenBy.reason + (hiddenBy.on === 'self' ? '' : ' on ancestor') : null
      },
      rules: rules, react: react, container: container, path: path
    };
  })(${params})`);
}

/** Detect the UI framework from runtime markers rather than page source. */
function probeFramework(run) {
  return evalJson(run, `(function () {
    if (document.querySelector('[ng-version]')) return 'angular';
    var els = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 400);
    var has = function (test) { return els.some(test); };
    if (document.querySelector('[data-reactroot]') ||
        has(function (n) { return Object.keys(n).some(function (k) { return /^__react(Fiber|Props|InternalInstance|EventHandlers)\\$/.test(k); }); })) return 'react';
    if (document.querySelector('[data-v-app]') || has(function (n) { return n.__vue__ || n.__vueParentComponent; })) return 'vue';
    if (has(function (n) { return Array.prototype.some.call(n.classList, function (c) { return c.indexOf('svelte-') === 0; }); })) return 'svelte';
    return 'unknown';
  })()`) || 'unknown';
}

/**
 * Network evidence. Prefer the engine's own capture; otherwise fall back to
 * the Resource Timing API, which every Chromium exposes. Resource Timing gives
 * URL, status (Chrome 109+) and timing, but no method or headers — so no
 * correlation id — and the caller is told which source was used.
 */
function probeNetwork(run) {
  const engine = engineList(run, 'network', ['entries', 'requests']);
  if (engine.supported) return { source: 'engine', entries: engine.entries };
  const entries = evalJson(run, `performance.getEntriesByType('resource')
    .filter(function (e) { return ['fetch', 'xmlhttprequest', 'beacon'].indexOf(e.initiatorType) >= 0; })
    .slice(-50)
    .map(function (e) {
      return { url: e.name, initiator: e.initiatorType, status: e.responseStatus || null,
               timestamp: Math.round(performance.timeOrigin + e.startTime), duration: Math.round(e.duration) };
    })`);
  if (Array.isArray(entries)) return { source: 'resource-timing', entries, engineGap: engine.reason };
  return { source: null, entries: [], unsupported: true, reason: engine.reason };
}

/**
 * Console evidence. Console messages cannot be read back after the fact, so if
 * the engine does not record them and no in-page recorder was installed, the
 * result is explicitly `unsupported` — never an empty list that reads as
 * "no errors occurred".
 */
function probeConsole(run) {
  const engine = engineList(run, 'console', ['entries', 'messages', 'logs']);
  if (engine.supported) return { source: 'engine', entries: engine.entries };
  const recorded = evalJson(run, 'window.__qeConsole || null');
  if (Array.isArray(recorded)) return { source: 'in-page-recorder', entries: recorded };
  return { source: null, entries: [], unsupported: true, reason: engine.reason };
}

/** Call an engine list command; report whether the engine supports it. */
function engineList(run, command, fields) {
  let stdout;
  try {
    stdout = run([command, '--json']);
  } catch (err) {
    const msg = `${err.message || ''} ${err.stderr || ''}`;
    const reason = /unknown command|unsupported command/i.test(msg)
      ? `the engine has no \`${command}\` command`
      : `\`${command}\` failed: ${msg.trim().split('\n')[0].slice(0, 160)}`;
    return { supported: false, reason };
  }
  let payload;
  try { payload = JSON.parse(String(stdout).trim()); } catch (_err) {
    return { supported: false, reason: `\`${command}\` returned non-JSON output` };
  }
  if (Array.isArray(payload)) return { supported: true, entries: payload };
  for (const f of fields) {
    if (payload && Array.isArray(payload[f])) return { supported: true, entries: payload[f] };
  }
  return { supported: false, reason: `\`${command}\` returned an unrecognised shape` };
}

/**
 * Page-level fallback when no target is named. Accepts both map shapes seen
 * in practice: structured `{ elements: [...] }` (Playwright backend) and
 * Vibium v26.8's `{ ok, result: "@e1 [input type=\\"checkbox\\"] \\"Toggle\\"\\n..." }`.
 */
function parseMap(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.elements)) return payload.elements;
  const text = typeof payload.result === 'string' ? payload.result : typeof payload === 'string' ? payload : '';
  const out = [];
  for (const line of text.split('\n')) {
    // Attributes appear both inside the brackets (`[input type="checkbox"]`)
    // and after them (`[input] placeholder="..."`); a bare trailing quoted
    // string is the element's text.
    const m = line.match(/^(@e\d+)\s+\[([a-z0-9-]+)([^\]]*)\](.*)$/i);
    if (!m) continue;
    const attributes = {};
    const pair = /([\w:-]+)="([^"]*)"/g;
    for (const a of `${m[3]} ${m[4]}`.matchAll(pair)) attributes[a[1]] = a[2];
    const textMatch = m[4].replace(pair, '').match(/"(.*)"/);
    const attrSel = Object.entries(attributes).map(([k, v]) => `[${k}="${v}"]`).join('');
    out.push({ ref: m[1], tag: m[2].toLowerCase(), attributes, text: textMatch ? textMatch[1] : '', selector: `${m[2].toLowerCase()}${attrSel}` });
  }
  return out;
}

module.exports = { evalJson, probeTarget, probeFramework, probeNetwork, probeConsole, parseMap };
