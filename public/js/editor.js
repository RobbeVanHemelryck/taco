// The stack's files, shown inline on the stack page: the compose file(s) and the
// env file, each in a CodeMirror editor with highlighting, line numbers,
// linting and completion. Compose files are linted locally (YAML syntax, known
// keys, references) and with `docker compose config` on the server; variables
// are matched across the compose and env files as you type. Saving refuses to
// clobber a file that changed on disk.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, hoverTooltip, placeholder, Decoration, ViewPlugin, MatchDecorator } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, StreamLanguage, indentUnit, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap, forceLinting } from '@codemirror/lint';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { yaml } from '@codemirror/lang-yaml';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { $, esc, icon, api, toast, dialog, menu, isTouch } from './ui.js';
import { TOP, SERVICE, keysAt } from './compose-schema.js';

// ================================================================ env & variable parsing

const ENV_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// KEY=VALUE lines -> Map(name -> { value, line, from, to })
function parseEnv(text) {
  const vars = new Map();
  let pos = 0;
  text.split('\n').forEach((l, i) => {
    const m = l.match(ENV_LINE);
    if (m) {
      let v = m[4].trim();
      const q = v[0];
      if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
      else v = v.replace(/\s+#.*$/, '');
      const from = pos + m[1].length + (m[2] || '').length;
      vars.set(m[3], { value: v, line: i + 1, from, to: from + m[3].length, dup: vars.get(m[3]) });
    }
    pos += l.length + 1;
  });
  return vars;
}

// ${VAR}, ${VAR:-default}, ${VAR?err}, $VAR -> [{ name, from, to, op, arg }]
const REF_RE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
function parseRefs(text) {
  const out = [];
  let pos = 0;
  for (const l of text.split('\n')) {
    const hash = l.search(/(^|\s)#/);
    const code = hash >= 0 ? l.slice(0, hash) : l;
    for (const m of code.matchAll(REF_RE)) {
      const name = m[1] || m[4];
      if (name) out.push({ name, from: pos + m.index, to: pos + m.index + m[0].length, op: m[2] || '', arg: m[3] ?? '' });
    }
    pos += l.length + 1;
  }
  return out;
}

const IGNORED_ENV = /^(COMPOSE_|DOCKER_)/;

// ================================================================ YAML helpers

// The chain of keys leading to `pos`, from indentation: ['services', 'web', 'ports'].
function yamlPath(doc, pos) {
  const line = doc.lineAt(pos);
  const m = line.text.match(/^(\s*)((?:-\s+)*)/);
  let col = Math.min(m[1].length + m[2].length, pos - line.from);
  const path = [];
  for (let n = line.number - 1; n >= 1 && col > 0; n--) {
    const t = doc.line(n).text;
    if (!t.trim() || /^\s*#/.test(t)) continue;
    const pm = t.match(/^(\s*)((?:-\s+)*)/);
    const ind = pm[1].length;
    const keyCol = ind + pm[2].length;
    const km = t.slice(keyCol).match(/^(?:"([^"]*)"|'([^']*)'|([^\s'"#:][^:#]*?))\s*:(?:\s|$)/);
    const key = km ? km[1] ?? km[2] ?? km[3] : null;
    if (keyCol < col && key != null) {
      path.unshift(key.trim());
      col = ind;
    } else if (ind < col) col = ind;
  }
  return path;
}

// Keys already present in the block a key at `pos` belongs to.
function siblingKeys(doc, pos) {
  const line = doc.lineAt(pos);
  const col = line.text.match(/^(\s*)((?:-\s+)*)/)[0].length;
  const seen = new Set();
  const scan = (dir) => {
    for (let n = line.number + dir; n >= 1 && n <= doc.lines; n += dir) {
      const t = doc.line(n).text;
      if (!t.trim() || /^\s*#/.test(t)) continue;
      const ind = t.match(/^\s*/)[0].length;
      if (ind < col) break;
      const km = ind === col && t.slice(ind).match(/^([\w.-]+)\s*:/);
      if (km) seen.add(km[1]);
    }
  };
  scan(-1);
  scan(1);
  return seen;
}

// Find the key node at a path like ['services', 'web', 'ports', 0] -> [from, to].
function findPath(doc, keys) {
  let node = doc.contents;
  let range = null;
  for (const k of keys) {
    if (isMap(node)) {
      const pair = node.items.find((p) => String(p.key?.value ?? p.key) === String(k));
      if (!pair) break;
      range = pair.key?.range || range;
      node = pair.value;
    } else if (isSeq(node) && /^\d+$/.test(k)) {
      const item = node.items[+k];
      if (!item) break;
      range = item.range || range;
      node = item;
    } else break;
  }
  return range && [range[0], range[1]];
}

// Map a `docker compose config` error to a position in the file.
function locate(text, msg) {
  const lines = text.split('\n');
  const lineRange = (n) => {
    const from = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    return [from, from + (lines[n - 1]?.length || 0)];
  };
  let m;
  if ((m = msg.match(/line (\d+)/)) && +m[1] <= lines.length) return lineRange(+m[1]);
  if ((m = msg.match(/variable "?([A-Za-z_]\w*)"?/))) {
    const r = parseRefs(text).find((x) => x.name === m[1]);
    if (r) return [r.from, r.to];
    const v = parseEnv(text).get(m[1]);
    if (v) return [v.from, v.to];
  }
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return lineRange(1);
  }
  if ((m = msg.match(/\b((?:services|networks|volumes|configs|secrets)(?:\.[\w-]+)+)/))) {
    const r = findPath(doc, m[1].split('.'));
    if (r) return r;
  }
  if ((m = msg.match(/service "?([\w.-]+)"?/))) {
    const r = findPath(doc, ['services', m[1]]);
    if (r) return r;
  }
  return lineRange(1);
}

// ================================================================ lint

function composeDiagnostics(text, env) {
  const diags = [];
  const add = (from, to, severity, message, source = 'compose') => diags.push({ from, to: Math.max(to, from + 1), severity, message, source });
  const len = text.length;
  const clamp = (n) => Math.max(0, Math.min(len, n));
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, keepSourceTokens: false });
  for (const e of doc.errors) add(clamp(e.pos[0]), clamp(e.pos[1]), 'error', e.message.split('\n')[0], 'yaml');
  for (const w of doc.warnings) add(clamp(w.pos[0]), clamp(w.pos[1]), 'warning', w.message.split('\n')[0], 'yaml');

  // Variables, matched against the env file as it is in its editor right now.
  if (env) {
    for (const r of parseRefs(text)) {
      if (env.vars.has(r.name) || IGNORED_ENV.test(r.name)) continue;
      if (r.op.endsWith('?')) add(r.from, r.to, 'error', `${r.name} is required but not set in ${env.name}`);
      else if (!r.op.endsWith('-') && !r.op.endsWith('+')) add(r.from, r.to, 'warning', `${r.name} is not set in ${env.name}, so it will be empty unless taco's environment has it`);
    }
  }
  if (doc.errors.length) return diags;

  const root = doc.contents;
  if (!root) return diags;
  if (!isMap(root)) {
    add(0, Math.min(len, 1), 'error', 'A compose file must be a mapping of keys (services:, networks:, …)');
    return diags;
  }
  const keyOf = (p) => String(isScalar(p.key) ? p.key.value : p.key);
  const keyRange = (p) => (p.key?.range ? [p.key.range[0], p.key.range[1]] : [0, 1]);
  for (const p of root.items) {
    const k = keyOf(p);
    if (!TOP[k] && !k.startsWith('x-')) add(...keyRange(p), 'warning', `Unknown top-level key "${k}"`);
    if (k === 'version') add(...keyRange(p), 'info', '"version" is obsolete and ignored by Compose v2');
  }
  const services = root.get('services', true);
  const networks = root.get('networks', true);
  const volumes = root.get('volumes', true);
  const names = (m) => (isMap(m) ? m.items.map(keyOf) : []);
  const svcNames = names(services);
  const netNames = names(networks);
  const volNames = names(volumes);
  if (!services && !root.get('include')) add(0, Math.min(len, 1), 'warning', 'No services defined');
  if (services && !isMap(services)) add(services.range?.[0] ?? 0, services.range?.[1] ?? 1, 'error', 'services must be a mapping of service names');

  for (const sp of isMap(services) ? services.items : []) {
    const name = keyOf(sp);
    const svc = sp.value;
    if (!isMap(svc)) {
      add(...keyRange(sp), 'error', `Service "${name}" must be a mapping`);
      continue;
    }
    const props = svc.items.map(keyOf);
    for (const p of svc.items) {
      const k = keyOf(p);
      if (!SERVICE[k] && !k.startsWith('x-')) add(...keyRange(p), 'warning', `Unknown service property "${k}"`);
      const v = p.value;
      const vr = v?.range ? [v.range[0], v.range[1]] : keyRange(p);
      const enumVals = SERVICE[k]?.values;
      if (enumVals && isScalar(v) && k !== 'network_mode' && k !== 'stop_grace_period' && k !== 'platform') {
        const s = String(v.value);
        if (!s.includes('$') && !enumVals.includes(s)) add(...vr, 'warning', `${k} should be one of: ${enumVals.join(', ')}`);
      }
      if (k === 'depends_on') {
        const deps = isSeq(v) ? v.items.map((x) => [String(x?.value ?? x), x?.range]) : isMap(v) ? v.items.map((x) => [keyOf(x), x.key?.range]) : [];
        for (const [d, r] of deps) {
          if (!svcNames.includes(d)) add(r?.[0] ?? vr[0], r?.[1] ?? vr[1], 'error', `depends_on: there is no service "${d}"`);
          else if (d === name) add(r?.[0] ?? vr[0], r?.[1] ?? vr[1], 'error', 'A service cannot depend on itself');
        }
      }
      if (k === 'networks' && !svc.get('network_mode')) {
        const ns = isSeq(v) ? v.items.map((x) => [String(x?.value ?? x), x?.range]) : isMap(v) ? v.items.map((x) => [keyOf(x), x.key?.range]) : [];
        for (const [n, r] of ns) if (n !== 'default' && !netNames.includes(n)) add(r?.[0] ?? vr[0], r?.[1] ?? vr[1], 'error', `Network "${n}" is not declared under the top-level networks:`);
      }
      if (k === 'volumes' && isSeq(v)) {
        for (const it of v.items) {
          if (!isScalar(it)) continue;
          const s = String(it.value);
          const src = s.split(':')[0];
          if (src && !/[/.~$]/.test(src[0]) && s.includes(':') && !volNames.includes(src)) {
            add(it.range[0], it.range[1], 'error', `Named volume "${src}" is not declared under the top-level volumes:`);
          }
        }
      }
      if (k === 'ports' && isSeq(v)) {
        for (const it of v.items) {
          if (!isScalar(it)) continue;
          const s = String(it.value);
          if (!s.includes('$') && !/^(\[?[\d.:a-fA-F]*\]?:)?(\d+(-\d+)?:)?\d+(-\d+)?(\/(tcp|udp|sctp))?$/.test(s)) add(it.range[0], it.range[1], 'warning', 'Expected a port like "8080:80" or "127.0.0.1:8080:80/tcp"');
        }
      }
    }
    if (!props.includes('image') && !props.includes('build') && !props.includes('extends')) add(...keyRange(sp), 'warning', `Service "${name}" has neither image nor build`);
  }
  return diags;
}

function envDiagnostics(text, composeTexts, composeName) {
  const diags = [];
  let pos = 0;
  const seen = new Map();
  text.split('\n').forEach((l, i) => {
    const from = pos;
    pos += l.length + 1;
    if (!l.trim() || /^\s*#/.test(l)) return;
    const m = l.match(ENV_LINE);
    if (!m) {
      diags.push({ from, to: from + l.length, severity: 'error', message: 'Expected KEY=value', source: 'env' });
      return;
    }
    const kf = from + m[1].length + (m[2] || '').length;
    if (seen.has(m[3])) diags.push({ from: kf, to: kf + m[3].length, severity: 'warning', message: `${m[3]} is already set on line ${seen.get(m[3])}; this later value wins`, source: 'env' });
    seen.set(m[3], i + 1);
    const v = m[4].trim();
    if ((v[0] === '"' || v[0] === "'") && v.lastIndexOf(v[0]) === 0) diags.push({ from: kf, to: from + l.length, severity: 'error', message: 'Unterminated quote', source: 'env' });
  });
  // An env_file: entry may pass every variable to containers, so "unused" means nothing then.
  if (composeTexts.length && !composeTexts.some((t) => /^\s*env_file\s*:/m.test(t))) {
    const used = new Set(composeTexts.flatMap((t) => parseRefs(t).map((r) => r.name)));
    for (const [k, v] of parseEnv(text)) {
      if (!used.has(k) && !IGNORED_ENV.test(k)) diags.push({ from: v.from, to: v.to, severity: 'info', message: `${k} is not used in ${composeName}`, source: 'env' });
    }
  }
  return diags;
}

// ================================================================ completion

const CAPS = ['ALL', 'NET_ADMIN', 'NET_RAW', 'NET_BIND_SERVICE', 'SYS_ADMIN', 'SYS_PTRACE', 'SYS_TIME', 'SYS_MODULE', 'SYS_NICE', 'CHOWN', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'MKNOD', 'IPC_LOCK'];

function composeCompletions(files) {
  return (ctx) => {
    const { state, pos } = ctx;
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const env = files.envVars();
    const text = state.doc.toString();
    const docNames = (top) => {
      try {
        const d = parseDocument(text);
        const m = d.get(top, true);
        return isMap(m) ? m.items.map((p) => String(p.key?.value ?? p.key)) : [];
      } catch {
        return [];
      }
    };

    // ${VAR
    let m = before.match(/\$\{([A-Za-z0-9_]*)$/);
    if (m) {
      return {
        from: pos - m[1].length,
        options: [...env].map(([name, v]) => ({ label: name, type: 'variable', detail: v.value ? `= ${v.value}` : '(empty)', apply: name + (line.text[pos - line.from] === '}' ? '' : '}') })),
        validFor: /^[A-Za-z0-9_]*$/,
      };
    }
    if (/^\s*#/.test(before)) return null;
    const path = yamlPath(state.doc, pos);

    // key: value
    m = before.match(/^\s*(?:-\s+)*([\w.-]+):\s+([^\s#]*)$/);
    if (m) {
      const spec = keysAt(path)?.[m[1]];
      if (!spec?.values) return null;
      return {
        from: pos - m[2].length,
        options: spec.values.map((v) => ({ label: v, type: 'enum', detail: m[1] })),
        validFor: /^[\w.:-]*$/,
      };
    }

    // - list item
    m = before.match(/^\s*-\s+([\w.-]*)$/);
    const parent = path[path.length - 1];
    const inService = path[0] === 'services' && path.length === 3;
    if (m && inService) {
      let opts = null;
      if (parent === 'depends_on') opts = docNames('services').filter((s) => s !== path[1]).map((s) => ({ label: s, type: 'class', detail: 'service' }));
      else if (parent === 'networks') opts = docNames('networks').map((s) => ({ label: s, type: 'class', detail: 'network' }));
      else if (parent === 'volumes') opts = docNames('volumes').map((s) => ({ label: s, type: 'class', detail: 'volume', apply: `${s}:/` }));
      else if (parent === 'cap_add' || parent === 'cap_drop') opts = CAPS.map((c) => ({ label: c, type: 'constant' }));
      else if (parent === 'env_file') opts = [{ label: '.env', type: 'text' }];
      if (opts) return { from: pos - m[1].length, options: opts, validFor: /^[\w.-]*$/ };
    }

    // key
    m = before.match(/^\s*(?:-\s+)*([\w.-]*)$/);
    if (!m || (!m[1] && !ctx.explicit)) return null;
    const from = pos - m[1].length;
    const present = siblingKeys(state.doc, pos);
    const after = line.text.slice(pos - line.from);
    const col = from - line.from;
    const keyOpt = (label, spec, type = 'property') => ({
      label,
      type,
      info: spec.info,
      detail: spec.t === 'map' ? '{…}' : spec.t === 'list' ? '[…]' : '',
      apply: (view, c, f, t) => {
        let insert = label;
        if (!/^\s*:/.test(after)) {
          const ind = ' '.repeat(col + 2);
          insert += spec.t === 'map' ? `:\n${ind}` : spec.t === 'list' ? `:\n${ind}- ` : ': ';
        }
        view.dispatch({ changes: { from: f, to: t, insert }, selection: { anchor: f + insert.length }, userEvent: 'input.complete' });
        if (spec.values) setTimeout(() => startCompletion(view), 0);
      },
    });
    let options = [];
    if (inService && parent === 'environment') {
      options = [...env.keys()].map((name) => ({ label: name, type: 'variable', detail: 'from .env', apply: `${name}: \${${name}}` }));
    } else if (path[0] === 'services' && path.length === 3 && parent === 'depends_on') {
      options = docNames('services').filter((s) => s !== path[1]).map((s) => keyOpt(s, { t: 'map', info: 'service' }, 'class'));
    } else if (inService && parent === 'networks') {
      options = docNames('networks').map((s) => keyOpt(s, { t: 'map', info: 'network' }, 'class'));
    } else {
      const keys = keysAt(path);
      if (!keys) return null;
      options = Object.entries(keys)
        .filter(([key]) => !present.has(key) || key === m[1])
        .map(([key, spec]) => keyOpt(key, spec));
    }
    return { from, options, validFor: /^[\w.-]*$/ };
  };
}

function envCompletions(files) {
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = before.match(/^\s*([A-Za-z0-9_]*)$/);
    if (!m || (!m[1] && !ctx.explicit)) return null;
    const have = parseEnv(ctx.state.doc.toString());
    const refs = new Map();
    for (const t of files.composeTexts()) for (const r of parseRefs(t)) if (!have.has(r.name) && !refs.has(r.name)) refs.set(r.name, r);
    return {
      from: ctx.pos - m[1].length,
      options: [...refs.values()].map((r) => ({ label: r.name, type: 'variable', detail: r.op.endsWith('-') ? `default ${r.arg}` : r.op.endsWith('?') ? 'required' : 'used in compose', apply: `${r.name}=` })),
      validFor: /^[A-Za-z0-9_]*$/,
    };
  };
}

// ================================================================ editor look

const highlight = HighlightStyle.define([
  { tag: [tags.definition(tags.propertyName), tags.propertyName], color: 'var(--syn-key)' },
  { tag: tags.content, color: 'var(--syn-value)' },
  { tag: [tags.string, tags.attributeValue], color: 'var(--syn-str)' },
  { tag: tags.special(tags.string), color: 'var(--syn-meta)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.separator, tags.punctuation, tags.squareBracket, tags.brace, tags.operator], color: 'var(--syn-punct)' },
  { tag: tags.labelName, color: 'var(--syn-anchor)' },
  { tag: tags.typeName, color: 'var(--syn-anchor)' },
  { tag: [tags.meta, tags.keyword], color: 'var(--syn-meta)' },
  { tag: tags.special(tags.variableName), color: 'var(--syn-var)' },
]);

const theme = EditorView.theme({
  '&': { fontSize: 'var(--ed-size)', backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0 14px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px 0 6px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-3)', border: 'none', paddingLeft: '6px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 4px 0 6px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--ed-active)' },
  '&:not(.cm-focused) .cm-activeLine': { backgroundColor: 'transparent' },
  '&:not(.cm-focused) .cm-activeLineGutter': { color: 'var(--text-3)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--ed-sel) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ed-match)', outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--text-3)', fontStyle: 'italic' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0' },
  '.cm-lint-marker': { width: '8px', height: '8px', margin: '7px 0 0 3px', borderRadius: '50%', content: 'none' },
  '.cm-lint-marker-error': { backgroundColor: 'var(--err)', content: 'none' },
  '.cm-lint-marker-warning': { backgroundColor: 'var(--warn)', content: 'none' },
  '.cm-lint-marker-info': { backgroundColor: 'var(--text-3)', content: 'none' },
  '.cm-tooltip': { border: 'none', backgroundColor: 'var(--popover)', color: 'var(--text)', borderRadius: '10px', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  '.cm-tooltip-lint': { padding: '4px' },
  '.cm-diagnostic': { padding: '6px 10px 6px 12px', fontFamily: 'var(--font)', fontSize: '12.5px', borderLeftWidth: '3px', borderRadius: '6px', lineHeight: '1.45', maxWidth: '460px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--err)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--text-3)' },
  '.cm-diagnosticSource': { color: 'var(--text-3)', fontSize: '11px', marginTop: '2px' },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px', maxHeight: '15em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 8px', borderRadius: '6px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  '.cm-completionIcon': { opacity: '.55', width: '1.2em' },
  '.cm-tooltip.cm-completionInfo': { padding: '6px 10px', fontFamily: 'var(--font)', fontSize: '12.5px', maxWidth: '260px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--font)', fontSize: '12px', borderRadius: '6px' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-match)', outline: '1px solid var(--warn)' },
  '.cm-var, .cm-var *': { color: 'var(--syn-var)', fontWeight: '500' },
  '.cm-num, .cm-num *': { color: 'var(--syn-num)' },
  '.cm-bool, .cm-bool *': { color: 'var(--syn-bool)' },
  '.cm-hover-var': { padding: '6px 10px', fontSize: '12.5px', fontFamily: 'var(--mono)' },
});

// ${VAR} references stand out wherever they appear (strings included).
const varHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.md = new MatchDecorator({ regexp: /\$\{[^}\n]*\}?|\$[A-Za-z_][A-Za-z0-9_]*/g, decoration: Decoration.mark({ class: 'cm-var' }) });
      this.decorations = this.md.createDeco(view);
    }
    update(u) {
      this.decorations = this.md.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// Plain YAML scalars all parse as "content"; colour numbers and booleans apart.
const scalarKinds = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = this.build(u.view);
    }
    build(view) {
      const marks = [];
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (n) => {
            if (n.name === 'Key') return false;
            if (n.name !== 'Literal') return;
            const s = view.state.doc.sliceString(n.from, n.to);
            if (/^(true|false|yes|no|on|off|null|~)$/i.test(s)) marks.push(Decoration.mark({ class: 'cm-bool' }).range(n.from, n.to));
            else if (/^[-+]?(\d[\d_]*(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) marks.push(Decoration.mark({ class: 'cm-num' }).range(n.from, n.to));
          },
        });
      }
      return Decoration.set(marks, true);
    }
  },
  { decorations: (v) => v.decorations },
);

// Hovering a ${VAR} shows its value from the env file.
const varHover = (files) =>
  hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const r = parseRefs(line.text).find((x) => pos >= line.from + x.from && pos <= line.from + x.to);
    if (!r) return null;
    const v = files.envVars().get(r.name);
    return {
      pos: line.from + r.from,
      end: line.from + r.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-hover-var';
        const val = v ? `<b>${esc(v.value || '""')}</b> <span style="color:var(--text-3)">· ${esc(files.envName())}:${v.line}</span>` : r.op.endsWith('-') ? `<b>${esc(r.arg)}</b> <span style="color:var(--text-3)">· default</span>` : '<span style="color:var(--warn)">not set</span>';
        dom.innerHTML = `<span style="color:var(--syn-var)">${esc(r.name)}</span> = ${val}`;
        return { dom };
      },
    };
  });

// .env files: KEY=value, comments, ${VAR} references in values.
const envLanguage = StreamLanguage.define({
  name: 'env',
  startState: () => ({ value: false }),
  token(stream, st) {
    if (stream.sol()) {
      st.value = false;
      if (stream.eatSpace()) return null;
      if (stream.peek() === '#') {
        stream.skipToEnd();
        return 'comment';
      }
      if (stream.match(/^export(?=\s)/)) return 'keyword';
    }
    if (!st.value) {
      if (stream.eatSpace()) return null;
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'propertyName';
      if (stream.eat('=')) {
        st.value = true;
        return 'operator';
      }
      stream.skipToEnd();
      return 'invalid';
    }
    if (stream.match(/^\s+#.*/)) return 'comment';
    if (stream.match(/^\$\{[^}]*\}?|^\$[A-Za-z_]\w*/)) return 'variableName.special';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?|^'[^']*'?/)) return 'string';
    stream.next();
    while (!stream.eol() && !/[\s$"']/.test(stream.peek())) stream.next();
    return 'content';
  },
  languageData: { commentTokens: { line: '#' } },
});

// ================================================================ the files section

export function mountFiles(root, bar, { project, runJob, onSaved }) {
  const pname = project.name;
  const enc = encodeURIComponent(pname);
  const files = []; // { path, kind, exists, mtime, original, view, card }
  const validCache = new Map();
  let destroyed = false;
  let busy = false;

  root.innerHTML = `
    <div class="sec-head"><h2>Configuration</h2><span class="sec-sub long">Linted as you type, validated with <code>docker compose config</code> before saving</span></div>
    <div class="files"><div class="fcard loading"><div class="shimmer"></div><div class="shimmer short"></div><div class="shimmer"></div></div></div>`;
  const grid = $('.files', root);

  const fname = (f) => f.path.split('/').pop();
  const text = (f) => f.view?.state.doc.toString() ?? '';
  const dirty = (f) => !!f.view && text(f) !== f.original;
  const envFile = () => files.find((f) => f.kind === 'env');
  const composeFiles = () => files.filter((f) => f.kind === 'compose');
  const model = {
    envVars: () => (envFile() ? parseEnv(text(envFile())) : new Map()),
    envName: () => (envFile() ? fname(envFile()) : '.env'),
    composeTexts: () => composeFiles().map(text),
  };

  // ---------------------------------------------------------------- status & save bar
  function setStatus(f, diags) {
    const el = $('[data-k="status"]', f.card);
    if (diags === 'checking') {
      el.className = 'fstatus checking';
      el.innerHTML = '<span class="spin sm"></span>Checking';
      return;
    }
    const errs = diags.filter((d) => d.severity === 'error').length;
    const warns = diags.filter((d) => d.severity === 'warning').length;
    f.diags = diags;
    if (errs) {
      el.className = 'fstatus err';
      el.innerHTML = `${icon('alert')}${errs} error${errs > 1 ? 's' : ''}${warns ? ` · ${warns} warning${warns > 1 ? 's' : ''}` : ''}`;
    } else if (warns) {
      el.className = 'fstatus warn';
      el.innerHTML = `${icon('alert')}${warns} warning${warns > 1 ? 's' : ''}`;
    } else {
      el.className = 'fstatus ok';
      el.innerHTML = `${icon('ok')}Valid`;
    }
  }

  function renderMeta(f) {
    $('.fdirty', f.card).hidden = !dirty(f);
    if (f.kind === 'env') {
      const n = parseEnv(text(f)).size;
      $('[data-k="sub"]', f.card).textContent = `${n} variable${n === 1 ? '' : 's'}${f.exists ? '' : ' · new file'}`;
    }
  }

  function renderBar() {
    const d = files.filter(dirty);
    bar.hidden = !d.length;
    if (!d.length) return;
    bar.innerHTML = `<div class="savebar-in">
      <span class="sb-dot"></span>
      <span class="sb-text">Unsaved changes <span class="muted">in ${d.map((f) => `<b>${esc(fname(f))}</b>`).join(', ')}</span></span>
      <span class="sp"></span>
      <button class="btn ghost" data-k="discard">Discard</button>
      <button class="btn" data-k="save">${icon('save')}<span>Save</span></button>
      <button class="btn primary" data-k="saveup">${icon('play')}<span>Save &amp; up</span></button>
    </div>`;
  }

  // ---------------------------------------------------------------- server validation
  async function validateRemote(f, content) {
    const key = `${f.path}\n${content}`;
    if (!validCache.has(key)) {
      validCache.set(
        key,
        api(`/api/projects/${enc}/validate`, { method: 'POST', body: { path: f.path, content } }).catch((e) => ({ ok: true, unavailable: e.message })),
      );
      if (validCache.size > 50) validCache.delete(validCache.keys().next().value);
    }
    return validCache.get(key);
  }

  const lintSource = (f) => async (view) => {
    const content = view.state.doc.toString();
    setStatus(f, 'checking');
    let diags;
    if (f.kind === 'env') diags = envDiagnostics(content, model.composeTexts(), composeFiles().map(fname).join(', ') || 'the compose file');
    else {
      const env = envFile() ? { vars: model.envVars(), name: model.envName() } : null;
      diags = composeDiagnostics(content, env);
    }
    // Ask docker compose too, unless the YAML itself is already broken.
    if (project.filesAccessible && !diags.some((d) => d.severity === 'error')) {
      const r = await validateRemote(f, content);
      if (!r.ok) {
        const [from, to] = locate(content, r.error);
        diags.push({ from, to: Math.max(to, from + 1), severity: 'error', message: r.error.replace(/^.*?(compose\.ya?ml|\.env|\.ya?ml):\s*/, ''), source: 'docker compose config' });
      }
    }
    if (view.state.doc.toString() === content) setStatus(f, diags);
    return diags;
  };

  // Edits in one file can change diagnostics in the others (variables).
  let crossTimer = 0;
  function relintOthers(f) {
    clearTimeout(crossTimer);
    crossTimer = setTimeout(() => {
      for (const o of files) if (o !== f && o.view) forceLinting(o.view);
    }, 350);
  }

  // ---------------------------------------------------------------- editors
  function makeEditor(f) {
    const exts = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorState.tabSize.of(2),
      indentUnit.of('  '),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (saveAll(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      syntaxHighlighting(highlight),
      theme,
      lintGutter(),
      linter(lintSource(f), { delay: 500 }),
      varHighlighter,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        renderMeta(f);
        renderBar();
        relintOthers(f);
      }),
      EditorView.contentAttributes.of({ 'aria-label': fname(f), autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
    ];
    if (isTouch) exts.push(EditorView.lineWrapping);
    if (f.kind === 'env') {
      exts.push(envLanguage, autocompletion({ override: [envCompletions(model)], icons: true }), placeholder('KEY=value\n# Variables used as ${KEY} in the compose file'));
    } else {
      exts.push(yaml(), scalarKinds, varHover(model), autocompletion({ override: [composeCompletions(model)], icons: true }), placeholder('services:\n  app:\n    image: nginx:alpine'));
    }
    f.view = new EditorView({ state: EditorState.create({ doc: f.original, extensions: exts }), parent: $('.fbody', f.card) });
  }

  function cardHtml(f) {
    const env = f.kind === 'env';
    return `<article class="fcard ${env ? 'env' : 'compose'}">
      <header class="fhead">
        <span class="ficon">${icon(env ? 'key' : 'file')}</span>
        <div class="ftitle">
          <div class="fname"><span>${esc(fname(f))}</span><span class="fdirty" hidden>Edited</span></div>
          <div class="fsub"><span data-k="sub">${env ? 'Environment' : 'Compose file'}</span><span class="fpath" title="${esc(f.path)}">\u200e${esc(f.path)}\u200e</span></div>
        </div>
        <button class="fstatus" data-k="status" title="Jump to the first problem"></button>
        <button class="iconbtn sm" data-k="fmenu" aria-label="File actions">${icon('more')}</button>
      </header>
      ${env && !f.exists ? `<div class="fnote">${icon('info')}<span>No env file yet. Variables added here are saved to <code>${esc(f.path)}</code>.</span></div>` : ''}
      <div class="fbody"></div>
    </article>`;
  }

  async function load() {
    let list;
    try {
      list = await api(`/api/projects/${enc}/files`);
    } catch (e) {
      grid.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
      return;
    }
    const loaded = await Promise.all(
      list.map((f) =>
        api(`/api/projects/${enc}/file?path=${encodeURIComponent(f.path)}`)
          .then((r) => ({ ...f, exists: r.exists, mtime: r.mtime, original: r.content }))
          .catch((e) => ({ ...f, error: e.message, original: '' })),
      ),
    );
    if (destroyed) return;
    grid.innerHTML = '';
    for (const f of loaded) {
      const holder = document.createElement('div');
      holder.innerHTML = cardHtml(f);
      f.card = holder.firstElementChild;
      grid.append(f.card);
      if (f.error) {
        $('.fbody', f.card).innerHTML = `<div class="notice">${esc(f.error)}</div>`;
        continue;
      }
      files.push(f);
      makeEditor(f);
      renderMeta(f);
    }
    grid.classList.toggle('two', files.length === 2);
  }

  // Pick up changes made on disk (e.g. from the CLI) to files that aren't being edited.
  async function reloadClean() {
    for (const f of files) {
      if (dirty(f)) continue;
      try {
        const r = await api(`/api/projects/${enc}/file?path=${encodeURIComponent(f.path)}`);
        if (r.content !== f.original && !dirty(f)) {
          f.original = r.content;
          f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: r.content } });
        }
        Object.assign(f, { mtime: r.mtime, exists: r.exists });
      } catch {}
    }
  }

  // ---------------------------------------------------------------- saving
  async function save(f, { force = false } = {}) {
    const content = text(f);
    try {
      const r = await api(`/api/projects/${enc}/file`, { method: 'PUT', body: { path: f.path, content, mtime: f.exists ? f.mtime : undefined, force } });
      Object.assign(f, { mtime: r.mtime, original: content, exists: true });
      $('.fnote', f.card)?.remove();
      validCache.clear();
      renderMeta(f);
      return true;
    } catch (e) {
      if (e.data?.validation) {
        const v = await dialog({ title: `${fname(f)} is invalid`, html: `<pre>${esc(e.message)}</pre>`, actions: [{ label: 'Save anyway', kind: 'danger', value: true }] });
        return v ? save(f, { force: true }) : false;
      }
      if (e.data?.conflict) {
        const v = await dialog({
          title: `${fname(f)} changed on disk`,
          message: 'It was modified outside taco (e.g. from the CLI) after it was opened here.',
          actions: [
            { label: 'Load theirs', value: 'reload' },
            { label: 'Overwrite', kind: 'danger', value: 'overwrite' },
          ],
        });
        if (v === 'overwrite') return save(f, { force: true });
        if (v === 'reload') {
          const r = await api(`/api/projects/${enc}/file?path=${encodeURIComponent(f.path)}`);
          Object.assign(f, { original: r.content, mtime: r.mtime, exists: r.exists });
          f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: r.content } });
        }
        return false;
      }
      toast(e.message, 'err');
      return false;
    }
  }

  // Env files first: the compose file is validated against the env file on disk.
  async function saveAll() {
    if (busy) return false;
    busy = true;
    try {
      const todo = files.filter(dirty).sort((a, b) => (a.kind === 'env' ? -1 : 0) - (b.kind === 'env' ? -1 : 0));
      if (!todo.length) return true;
      for (const f of todo) if (!(await save(f))) return false;
      toast(`Saved ${todo.map(fname).join(', ')}`, 'ok');
      onSaved?.();
      return true;
    } finally {
      busy = false;
      renderBar();
      for (const f of files) forceLinting(f.view);
    }
  }

  function discard() {
    for (const f of files) {
      if (dirty(f)) f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: f.original } });
    }
  }

  function jumpToProblem(f) {
    const d = (f.diags || []).slice().sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || a.from - b.from)[0];
    if (!d) return;
    f.view.dispatch({ selection: { anchor: d.from, head: d.to }, effects: EditorView.scrollIntoView(d.from, { y: 'center' }) });
    f.view.focus();
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-k]');
    if (!t) return;
    const f = files.find((x) => x.card?.contains(t));
    if (!f) return;
    if (t.dataset.k === 'status') jumpToProblem(f);
    else if (t.dataset.k === 'fmenu') {
      const v = await menu(t, {
        title: fname(f),
        subtitle: f.path,
        items: [
          { label: 'Check with docker compose', icon: 'ok', value: 'check' },
          { label: 'Revert changes', icon: 'undo', value: 'revert', disabled: !dirty(f) },
          { label: 'Copy path', icon: 'file', value: 'copy' },
        ],
      });
      if (v === 'check') {
        validCache.clear();
        forceLinting(f.view);
      } else if (v === 'revert') f.view.dispatch({ changes: { from: 0, to: f.view.state.doc.length, insert: f.original } });
      else if (v === 'copy') navigator.clipboard?.writeText(f.path).then(() => toast('Path copied'), () => toast(f.path));
    }
  });

  bar.onclick = async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k === 'discard') {
      if (await dialog({ title: 'Discard changes?', message: `Unsaved edits in ${files.filter(dirty).map(fname).join(', ')} will be lost.`, actions: [{ label: 'Discard', kind: 'danger', value: true }] })) discard();
    } else if (k === 'save') saveAll();
    else if (k === 'saveup') {
      if (await saveAll()) runJob(`Up ${pname}`, `/api/projects/${enc}/action/up`, {});
    }
  };

  const onUnload = (e) => {
    if (files.some(dirty)) e.preventDefault();
  };
  addEventListener('beforeunload', onUnload);

  load();

  return {
    canLeave: () => !files.some(dirty),
    dirtyNames: () => files.filter(dirty).map(fname),
    reloadClean,
    focus() {
      const f = composeFiles()[0];
      if (!f) return;
      f.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      f.view.focus();
    },
    destroy() {
      destroyed = true;
      clearTimeout(crossTimer);
      removeEventListener('beforeunload', onUnload);
      for (const f of files) f.view?.destroy();
      bar.hidden = true;
      bar.onclick = null;
    },
  };
}
