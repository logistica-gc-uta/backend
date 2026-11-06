/** Gráficos SVG sin dependencias, pensados para incrustarse en el reporte Markdown. */
export interface Series {
  name: string;
  values: readonly number[];
  color: string;
}

const W = 720;
const H = 360;
const M = { left: 70, right: 20, top: 44, bottom: 60 };

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Paleta apta para daltonismo (Okabe-Ito). */
export const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00'] as const;

/** Valor "redondo" por encima del máximo para el eje Y. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * base;
}

const fmt = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value * 10) / 10));

function frame(title: string, yLabel: string, xLabels: readonly string[], top: number, centered: boolean, body: (x: (i: number) => number, y: (v: number) => number) => string, legend: Series[]): string {
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (i: number) =>
    M.left + (centered ? (plotW * (i + 0.5)) / xLabels.length : xLabels.length === 1 ? plotW / 2 : (plotW * i) / (xLabels.length - 1));
  const y = (v: number) => M.top + plotH - (Math.max(0, v) / top) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const yy = M.top + plotH - f * plotH;
      return `<line x1="${M.left}" y1="${yy}" x2="${W - M.right}" y2="${yy}" stroke="#d0d7de" stroke-width="1"/><text x="${M.left - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#57606a">${fmt(top * f)}</text>`;
    })
    .join('');
  const ticks = xLabels.map((label, i) => `<text x="${x(i)}" y="${H - M.bottom + 18}" text-anchor="middle" font-size="11" fill="#57606a">${esc(label)}</text>`).join('');
  const key = legend
    .map((s, i) => `<g transform="translate(${M.left + i * 130},${H - 16})"><rect width="12" height="12" fill="${s.color}" rx="2"/><text x="18" y="10" font-size="12" fill="#24292f">${esc(s.name)}</text></g>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#24292f">${esc(title)}</text>
<text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle" font-size="11" fill="#57606a">${esc(yLabel)}</text>
${grid}${ticks}${body(x, y)}${key}
</svg>
`;
}

export function lineChart(options: { title: string; yLabel: string; xLabels: readonly string[]; series: Series[] }): string {
  const { title, yLabel, xLabels, series } = options;
  const values = series.flatMap((s) => s.values.filter(Number.isFinite));
  const top = niceMax(Math.max(...values, 0));
  return frame(title, yLabel, xLabels, top, false, (x, y) =>
    series
      .map((s) => {
        const points = s.values.map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : '')).filter(Boolean);
        const dots = s.values.map((v, i) => (Number.isFinite(v) ? `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${s.color}"/>` : '')).join('');
        return `<polyline points="${points.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.5"/>${dots}`;
      })
      .join(''), series);
}

export function barChart(options: { title: string; yLabel: string; xLabels: readonly string[]; series: Series[] }): string {
  const { title, yLabel, xLabels, series } = options;
  const values = series.flatMap((s) => s.values.filter(Number.isFinite));
  const top = niceMax(Math.max(...values, 0));
  const groupW = ((W - M.left - M.right) / xLabels.length) * 0.7;
  const barW = groupW / series.length;
  return frame(title, yLabel, xLabels, top, true, (x, y) =>
    series
      .map((s, si) =>
        s.values
          .map((v, i) => {
            if (!Number.isFinite(v)) return '';
            const bx = x(i) - groupW / 2 + si * barW;
            const by = y(v);
            return `<rect x="${bx}" y="${by}" width="${barW - 2}" height="${Math.max(0, y(0) - by)}" fill="${s.color}" rx="2"><title>${esc(s.name)}: ${fmt(v)}</title></rect>`;
          })
          .join(''),
      )
      .join(''), series);
}
