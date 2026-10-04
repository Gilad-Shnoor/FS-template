// Minimal, dependency-free YAML emitter for generated Kubernetes manifests.
// Scripts in this repo intentionally have zero npm dependencies so they work before `npm install`.

const PLAIN = /^[A-Za-z_./][A-Za-z0-9_./:@-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (s !== '' && PLAIN.test(s) && !RESERVED.test(s) && !/^[0-9.]+$/.test(s)) return s;
  return JSON.stringify(s);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0);

function emit(value, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return ' []';
    return value
      .map((item) => {
        if (isObject(item) && !isEmpty(item)) {
          const body = emit(item, indent + 1).replace(/^\n/, '');
          // first key goes on the dash line
          return `\n${pad}- ${body.slice((indent + 1) * 2)}`;
        }
        if (Array.isArray(item)) return `\n${pad}- ${JSON.stringify(item)}`; // flow style for nested lists
        return `\n${pad}-${emitInline(item, indent + 1)}`;
      })
      .join('');
  }
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return ' {}';
    return keys.map((k) => `\n${pad}${scalar(k)}:${emitInline(value[k], indent + 1)}`).join('');
  }
  return ` ${scalar(value)}`;
}

function emitInline(value, indent) {
  if (typeof value === 'string' && value.includes('\n')) {
    const pad = '  '.repeat(indent);
    const body = value.replace(/\n$/, '').split('\n').map((l) => (l ? pad + l : '')).join('\n');
    return ` |${value.endsWith('\n') ? '' : '-'}\n${body}`;
  }
  if (Array.isArray(value) || isObject(value)) return emit(value, Array.isArray(value) ? indent - 1 : indent);
  return ` ${scalar(value)}`;
}

export function toYaml(doc) {
  return emit(doc, 0).replace(/^\n/, '') + '\n';
}

export function toYamlDocs(docs, header = '') {
  return header + docs.filter(Boolean).map(toYaml).join('---\n');
}
