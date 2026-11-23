// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns exactly makefun-site's build(input) for every input:
// the output tree (path -> file text), byte for byte. No network, no clock,
// no randomness, no file access, no caching between cases: every cache below
// is created fresh inside run() and discarded with it.
//
// Speed plan (same semantics, less work):
//  - slugify: ASCII fast path + per-run cache (titles/tags repeat constantly).
//  - HTML escaping: one regex test, then a single pass; never a regex per char.
//  - Markdown inline: run-accumulation, no per-character escape calls.
//  - Markdown lex: first-character dispatch instead of a regex per pattern.
//  - Front matter: manual key/value scan instead of a regex per line.
//  - Templates: scope-chain rendering (no per-render spread of site/tags/recent),
//    array accumulation + join instead of repeated string concatenation.
//  - Cards: a post's card is computed once and reused by its page.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;

function escapeHtml(s) {
  if (!HAS_SPECIAL.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ESCAPES[s[i]];
    if (e !== undefined) {
      out += s.slice(start, i) + e;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

const SLUG_MAX = 64;

// Slow path, identical to the reference: NFKD, drop combining marks,
// A-Z lowered, every run of non [a-z0-9] one '-', none at either end,
// cut to 64 chars (a '-' left at the cut dropped), 'untitled' if empty.
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Slug of `text`, cached per run. ASCII-only input is exactly the slow
// path (NFKD is the identity on ASCII, and ASCII holds no combining
// marks), so the fast loop below returns the same string.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      let keep = null;
      if (c >= 'A' && c <= 'Z') keep = c.toLowerCase();
      else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) keep = c;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    out = slugifySlow(text);
  }
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, s);
  return s;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Exactly JavaScript's \s (White_Space plus the line terminators).
    const ws = code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || code === 160 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Parse one "key: value" line the way /^([a-z_]+):(?: (.*))?$/ does:
// key of [a-z_]+, then either the end, or one space and the value.
function parseKeyLine(line) {
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  for (let i = 0; i < colon; i++) {
    const c = line[i];
    if (!((c >= 'a' && c <= 'z') || c === '_')) return null;
  }
  if (line.length === colon + 1) return { key: line.slice(0, colon), raw: '' };
  if (line[colon + 1] !== ' ') return null;
  let raw = line.slice(colon + 2);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  return { key: line.slice(0, colon), raw: raw.slice(0, end) };
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const kv = parseKeyLine(line);
    if (kv === null) return { error: `line ${i + 1} is not "key: value"` };
    const { key, raw } = kv;
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

// A fence-open line: ``` + optional language, then spaces/tabs only.
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}

function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

// A heading line's level and text, or null (text never empty; 7+ '#' no).
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    let isOrdered = false;
    let start = 1;
    let firstText = null;
    if (line[0] === '-' || line[0] === '*') {
      if (line[1] === ' ') firstText = line.slice(2);
    } else {
      let d = 0;
      while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
        isOrdered = true;
        start = Number(line.slice(0, d));
        firstText = line.slice(d + 2);
      }
    }
    if (firstText !== null) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        let text = null;
        if (isOrdered) {
          let d = 0;
          while (d < l.length && l[d] >= '0' && l[d] <= '9') d++;
          if (d >= 1 && d <= 9 && l[d] === '.' && l[d + 1] === ' ') text = l.slice(d + 2);
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          text = l.slice(2);
        }
        if (text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (l.length >= 3 && l[0] === ' ' && l[1] === ' ') {
          // Continued item: two or more spaces, then a non-whitespace char.
          let k = 2;
          while (k < l.length && l[k] === ' ') k++;
          if (k < l.length && /\S/.test(l[k])) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// The character codes a backslash escapes (same set as ESCAPABLE).
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 || code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 || code === 33 || code === 62;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL_RE = /[\\`*\[&<>"']/g;

function inline(s, env) {
  // One C++ regex scan finds the next special character; plain runs between
  // them are copied whole. SPECIAL_RE is shared, but every exec is preceded
  // by setting lastIndex, so the recursion below cannot disturb the scan.
  let out = '';
  let start = 0;
  let i = 0;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null) return out + s.slice(start);
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
        out += s.slice(start, j) + s[j + 1];
        i = j + 2;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(start, j) + `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += s.slice(start, j) + `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          start = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += s.slice(start, j) + `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !/\s/.test(target)) {
        out += s.slice(start, j) + `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = q + 1;
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    // One of & < > " '.
    out += s.slice(start, j) + ESCAPES[c];
    i = j + 1;
    start = i;
  }
}

function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    if (t.type === 'heading') {
      const id = uniqueSlug(slugify(t.text, slugCache), ids);
      const html = inline(t.text, env);
      blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
      if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
    } else if (t.type === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
      blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
    } else if (t.type === 'hr') {
      blocks.push('<hr>');
    } else if (t.type === 'blockquote') {
      blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
    } else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
    } else {
      const html = inline(t.text, env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      // Neighbouring text nodes render identically as one: merge them.
      const last = body[body.length - 1];
      if (last !== undefined && last.kind === 'text') last.text += tok.text;
      else body.push({ kind: 'text', text: tok.text });
    } else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      out.push(ctx.escape(textOf(lookup(scope, n.path))));
    } else if (n.kind === 'raw') {
      out.push(textOf(lookup(scope, n.path)));
    } else if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- Build

const RESERVED = new Set(['posts', 'tags', 'page']);

function readSources(files) {
  const sorted = [...files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }
  return { sources, statics };
}

function frontMatter(b, s, templates, report) {
  const fm = parseFrontMatter(s.text);
  if ('error' in fm) {
    report.push(`refused ${s.path}: ${fm.error}`);
    return null;
  }
  s.data = fm.data;
  s.body = fm.body;
  s.post = s.path.startsWith('posts/');
  const own = [...RESERVED].find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
  if (own !== undefined) {
    report.push(`refused ${s.path}: ${own}/ is the generator's own`);
    return null;
  }
  if (s.post && !Object.hasOwn(s.data, 'date')) {
    report.push(`refused ${s.path}: a post needs a date`);
    return null;
  }
  s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
  if (!templates.has(s.layout)) {
    report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
    return null;
  }
  if (s.data.draft === true) {
    report.push(`draft ${s.path}`);
    return null;
  }
  return s;
}

function permalinks(b, kept) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, b.slugCache), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function markdown(b, kept, statics) {
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const m = renderMarkdown(s.body, env, b.slugCache);
    s.html = m.html;
    s.toc = m.toc;
    s.excerpt = m.excerpt;
  }
  return broken;
}

function collections(b, kept) {
  const posts = kept.filter((s) => s.post);
  posts.sort((a, b2) => byCodeUnits(b2.data.date, a.data.date) || byCodeUnits(a.slug, b2.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  return posts;
}

// A source's tags, each slug once, in its own order.
function ownTags(b, s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name, b.slugCache);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

function tags(b, kept, posts) {
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(b, p)) {
      const slug = slugify(name, b.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(b, s).map((name) => bySlug.get(slugify(name, b.slugCache)) ?? { name, slug: slugify(name, b.slugCache), url: '', posts: [] });
    }
  }
  return [...bySlug.values()].sort((a, b2) => b2.posts.length - a.posts.length || byCodeUnits(a.slug, b2.slug));
}

// A tag as templates read it (its posts as cards).
function tagOf(b, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
}

function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, b.dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(b, s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, b.dateCache) };
}

function pageOf(b, s) {
  const card = b.cards.get(s) ?? cardOf(b, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(b, s.newer ?? null),
    older: linkOf(b, s.older ?? null),
    is_post: s.post,
  };
}

function layouts(b, kept, statics) {
  b.posts = collections(b, kept);
  const tagList = tags(b, kept, b.posts);
  // Cards only after tags(): cardOf reads each source's tagRefs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  b.tagCount = tagList.length;
  const site = { title: b.site.title, base_url: b.base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.site.recent).map((p) => b.cards.get(p));
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const t = b.templates.get(name);
    if (t === undefined) return null;
    const parts = [];
    renderNodes(t, { vars, parent: baseScope }, ctx, 0, parts);
    return parts.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  return output;
}

function build(input) {
  const report = [];
  const b = {
    site: input.site,
    base: input.site.base_url.replace(/\/+$/, ''),
    slugCache: new Map(),
    dateCache: new Map(),
    templates: new Map(),
    bySource: new Map(),
    report,
    posts: [],
    cards: new Map(),
    tagCount: 0,
  };
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      b.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) report.push(e.message);
      else throw e;
    }
  }
  const { sources, statics } = readSources(input.files);
  const kept = [];
  for (const s of sources) {
    const keptSource = frontMatter(b, s, b.templates, report);
    if (keptSource !== null) kept.push(keptSource);
  }
  permalinks(b, kept);
  const broken = markdown(b, kept, statics);
  const output = layouts(b, kept, statics);
  const pages = kept.filter((s) => !s.post).length;
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tagCount} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** The output tree for one case's input, exactly as makefun-site builds it. */
export function run(input) {
  return build(input);
}
