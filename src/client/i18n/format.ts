/**
 * Minimal ICU-style message formatting: `{name}` placeholders and
 * `{count, plural, one {…} other {…}}` blocks (with `#` for the number and
 * placeholders allowed inside branches). Plural categories come from
 * Intl.PluralRules, so Macedonian rules (e.g. 21 → "one") are handled.
 */
export type MessageValues = Record<string, string | number>;

export function formatMessage(template: string, values: MessageValues = {}, locale = 'en'): string {
  return substitute(expandPlurals(template, values, locale), values);
}

function expandPlurals(template: string, values: MessageValues, locale: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf('{', i);
    if (start === -1) {
      out += template.slice(i);
      break;
    }
    const header = /^\{(\w+),\s*plural,\s*/.exec(template.slice(start));
    if (!header) {
      out += template.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    out += template.slice(i, start);
    const name = header[1]!;
    let cursor = start + header[0].length;
    const branches = new Map<string, string>();
    while (cursor < template.length && template[cursor] !== '}') {
      const selector = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(template.slice(cursor));
      if (!selector) break;
      cursor += selector[0].length;
      let depth = 1;
      const bodyStart = cursor;
      while (cursor < template.length && depth > 0) {
        if (template[cursor] === '{') depth++;
        else if (template[cursor] === '}') depth--;
        cursor++;
      }
      branches.set(selector[1]!, template.slice(bodyStart, cursor - 1));
      while (template[cursor] === ' ') cursor++;
    }
    cursor++; // closing brace of the plural block
    const count = Number(values[name] ?? 0);
    const category = new Intl.PluralRules(locale).select(count);
    const body = branches.get(`=${count}`) ?? branches.get(category) ?? branches.get('other') ?? '';
    out += body.replace(/#/g, new Intl.NumberFormat(locale).format(count));
    i = cursor;
  }
  return out;
}

function substitute(template: string, values: MessageValues): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}
