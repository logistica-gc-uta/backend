/** Convierte filas en CSV (RFC 4180 simple): comillas dobles solo cuando hace falta. */
export function csv(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const cell = (value: unknown) => {
    const text =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value as string | number | boolean);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => cell(row[h])).join(','))].join('\n') + '\n';
}

/**
 * JSON legible y compacto: los objetos de primer nivel con sangría de 2 espacios y
 * cada elemento de un arreglo en su propia línea. Es JSON estándar (se lee con
 * JSON.parse) y los cambios por dataset quedan en una sola línea del diff.
 */
export function stringifyReport(report: Record<string, unknown>): string {
  const entries = Object.entries(report);
  const lines = ['{'];
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, i) => lines.push(`    ${JSON.stringify(item)}${i < value.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}
