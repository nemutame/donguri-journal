/**
 * Tiny dependency-free SVG bar-chart builder, rasterized to PNG via sharp.
 *
 * Reviews return rendered PNG charts (plus structured data and presentation
 * hints) so the front-end LLM can present richly — markdown alone is not enough.
 * sharp is an OPTIONAL peer dependency (not installed by default, to keep the
 * base install light and reliable). It is imported lazily, so the server starts
 * fine without it; callers fall back to data-only output if the import or render
 * throws. Install `sharp` alongside the server to enable PNG charts.
 */

export interface BarDatum {
  label: string;
  value: number;
}

const COLORS = {
  bg: "#ffffff",
  bar: "#4f46e5",
  axis: "#9ca3af",
  text: "#1f2937",
  subtext: "#6b7280",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build a vertical bar chart as an SVG string. */
export function barChartSvg(title: string, data: BarDatum[]): string {
  const marginTop = 40;
  const marginBottom = 64;
  const marginLeft = 44;
  const marginRight = 16;

  const n = Math.max(data.length, 1);
  const slot = Math.max(18, Math.min(56, Math.floor(640 / n)));
  const barW = Math.max(8, slot - 10);
  const plotW = n * slot;
  const plotH = 200;
  // Width must fit both the bars and the (left-aligned) title; ~9.5px/char at 15px bold.
  const barsWidth = marginLeft + plotW + marginRight;
  const titleWidth = marginLeft + Math.ceil(title.length * 9.5) + marginRight;
  const width = Math.max(barsWidth, titleWidth);
  const height = marginTop + plotH + marginBottom;

  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const baselineY = marginTop + plotH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);
  parts.push(
    `<text x="${marginLeft}" y="24" font-size="15" font-weight="600" fill="${COLORS.text}">${esc(title)}</text>`,
  );
  // y-axis max label + baseline
  parts.push(
    `<text x="${marginLeft - 8}" y="${marginTop + 4}" font-size="11" text-anchor="end" fill="${COLORS.subtext}">${maxValue}</text>`,
  );
  parts.push(
    `<line x1="${marginLeft}" y1="${baselineY}" x2="${marginLeft + plotW}" y2="${baselineY}" stroke="${COLORS.axis}" stroke-width="1"/>`,
  );

  data.forEach((d, i) => {
    const h = Math.round((d.value / maxValue) * plotH);
    const x = marginLeft + i * slot + (slot - barW) / 2;
    const y = baselineY - h;
    parts.push(
      `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="${COLORS.bar}"/>`,
    );
    if (d.value > 0) {
      parts.push(
        `<text x="${x + barW / 2}" y="${y - 4}" font-size="10" text-anchor="middle" fill="${COLORS.subtext}">${d.value}</text>`,
      );
    }
    const cx = x + barW / 2;
    const ly = baselineY + 14;
    parts.push(
      `<text x="${cx}" y="${ly}" font-size="10" text-anchor="end" fill="${COLORS.text}" transform="rotate(-45 ${cx} ${ly})">${esc(d.label)}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("");
}

/** Rasterize an SVG string to a PNG buffer using sharp (lazy-loaded). */
export async function renderPng(svg: string): Promise<Buffer> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
