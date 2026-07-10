import { BRAND, getAgentIdentity } from './emailBrand';

/**
 * Reusable HTML building blocks for Vern's outreach emails. All markup uses
 * table-based layout + inline styles (no <style> blocks, no flex/grid) —
 * the only safe subset across Gmail, Outlook desktop, and Apple Mail.
 * Matches the `crm-ckeditor-email-wrap` structure Lofty's own composer
 * produces, so templates sent via the API render identically to ones
 * pasted through the Lofty UI.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wraps inner content in the 600px centered table shell + outer background. */
export function emailShell(innerHtml: string): string {
  return `<div class="crm-ckeditor-email-wrap" style="color:#515666;font-size:16px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-family:${BRAND.fontStack};line-height:1.5;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.colors.bg}; padding:24px 0; font-family:${BRAND.fontStack};"><tbody><tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; max-width:600px; width:100%;"><tbody>` +
    innerHtml +
    `</tbody></table></td></tr></tbody></table></div>`;
}

/** Navy hero header with a gold eyebrow label + headline. Used by the "direct" (property/welcome) template family. */
export function heroHeader(opts: { eyebrow: string; titleHtml: string }): string {
  return `<tr><td style="background-color:${BRAND.colors.navy}; padding:40px 40px 32px 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr><td>` +
    `<div style="width:24px; height:24px; border-top:2px solid ${BRAND.colors.gold}; border-left:2px solid ${BRAND.colors.gold}; margin-bottom:20px;">&nbsp;</div>` +
    `<p style="margin:0 0 8px 0; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:${BRAND.colors.gold}; font-weight:700;">${escapeHtml(opts.eyebrow)}</p>` +
    `<h1 style="margin:0; font-size:26px; line-height:1.3; color:#ffffff; font-weight:800; letter-spacing:-0.3px;">${opts.titleHtml}</h1>` +
    `</td></tr></tbody></table></td></tr>`;
}

/** Lighter header for the market-snapshot template family — coral rule, serif headline, dateline. */
export function reportHeader(opts: { dateline: string; titleHtml: string; subtitle: string }): string {
  return `<tr><td style="background:${BRAND.colors.bgCard};border-bottom:2px solid ${BRAND.colors.coral};padding:32px 40px 24px;">` +
    `<p style="margin:0 0 8px;font-size:10px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.colors.coral};">${escapeHtml(opts.dateline)}</p>` +
    `<h1 style="margin:0 0 6px;font-size:26px;font-weight:700;color:${BRAND.colors.navySoft};line-height:1.25;font-family:${BRAND.serifStack};">${opts.titleHtml}</h1>` +
    `<p style="margin:0;font-size:12px;color:${BRAND.colors.muted};">${escapeHtml(opts.subtitle)}</p>` +
    `</td></tr>`;
}

export function paragraph(text: string, opts: { color?: string; size?: number; muted?: boolean } = {}): string {
  const color = opts.color ?? (opts.muted ? BRAND.colors.muted : BRAND.colors.slate);
  const size = opts.size ?? 15;
  return `<p style="margin:0 0 16px;font-size:${size}px;color:${color};line-height:1.75;">${text}</p>`;
}

export function ctaButton(opts: { label: string; href: string; align?: 'left' | 'center' }): string {
  const align = opts.align ?? 'left';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;${align === 'center' ? ' margin-left:auto; margin-right:auto;' : ''}"><tbody><tr>` +
    `<td style="background-color:${BRAND.colors.navy}; border-radius:4px;"><a style="display:inline-block; padding:14px 28px; font-size:13px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.colors.gold}; font-weight:700; text-decoration:none; font-family:${BRAND.fontStack};" target="_blank" href="${escapeHtml(opts.href)}">${escapeHtml(opts.label)}</a></td>` +
    `</tr></tbody></table>`;
}

/** Coral-accented callout box for a single headline stat or takeaway. */
export function calloutBox(html: string): string {
  return `<div style="background:${BRAND.colors.bgCard};border-left:3px solid ${BRAND.colors.coral};padding:16px 20px;margin:20px 0;border-radius:0 6px 6px 0;">` +
    `<p style="margin:0;font-size:14px;color:${BRAND.colors.navySoft};line-height:1.75;">${html}</p></div>`;
}

export interface MetricCard {
  label: string;
  value: string;
  sub?: string;
  subColor?: string;
}

/** Row of up to 4 stat cards, e.g. active/sold counts by property type. */
export function metricCardRow(cards: MetricCard[]): string {
  const cellWidth = Math.floor(96 / cards.length);
  const cells = cards
    .map(
      (card, i) =>
        `<td width="${cellWidth}%" style="background:${BRAND.colors.bgCard};border:1px solid ${BRAND.colors.border};border-radius:8px;padding:14px 8px;text-align:center;vertical-align:top;">` +
        `<p style="margin:0 0 5px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.colors.muted};font-weight:600;">${escapeHtml(card.label)}</p>` +
        `<p style="margin:0 0 3px;font-size:24px;font-weight:700;color:${BRAND.colors.navySoft};font-family:${BRAND.serifStack};">${escapeHtml(card.value)}</p>` +
        (card.sub ? `<p style="margin:0;font-size:11px;color:${card.subColor ?? BRAND.colors.muted};font-weight:500;">${escapeHtml(card.sub)}</p>` : '') +
        `</td>` +
        (i < cards.length - 1 ? `<td width="2%">&nbsp;</td>` : ''),
    )
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tbody><tr>${cells}</tr></tbody></table>`;
}

export interface BarChartRow {
  label: string;
  segments: Array<{ value: number; color: string }>;
  highlight?: boolean;
}

/**
 * Horizontal proportional bar chart (each row can carry multiple stacked-
 * looking segments, e.g. active vs sold). Widths scale against the largest
 * single segment value across all rows so bars stay comparable.
 */
export function horizontalBarChart(opts: { caption: string; rows: BarChartRow[]; legend: [string, string] }): string {
  const maxValue = Math.max(1, ...opts.rows.flatMap((r) => r.segments.map((s) => s.value)));
  const rowsHtml = opts.rows
    .map((row) => {
      const bg = row.highlight ? 'background:rgba(241,100,95,0.05);' : '';
      const pad = row.highlight ? '7px 4px' : '5px 0';
      const bars = row.segments
        .map((seg, i) => {
          const widthPct = Math.max(2, Math.round((seg.value / maxValue) * 100));
          const height = row.highlight ? 10 : 8;
          return `<div style="background:${seg.color}; width:${widthPct}%; height:${height}px; border-radius:2px;${i === 0 ? ' margin-bottom:2px;' : ''}">&nbsp;</div>`;
        })
        .join('');
      const labelColor = row.highlight ? BRAND.colors.coral : BRAND.colors.navySoft;
      const labelWeight = row.highlight ? 700 : 500;
      return `<tr style="${bg}"><td style="padding:${pad}; color:${labelColor}; font-weight:${labelWeight};">${escapeHtml(row.label)}</td><td style="padding:${pad};">${bars}</td></tr>`;
    })
    .join('');
  return `<div style="background:#ffffff;border:1px solid ${BRAND.colors.border};border-radius:10px;padding:20px 18px 16px;margin:20px 0;box-shadow:0 1px 3px rgba(0,0,0,0.05);">` +
    `<p style="margin:0 0 14px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.colors.muted};">${escapeHtml(opts.caption)}</p>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:11px;"><tbody>${rowsHtml}</tbody></table>` +
    `<table cellpadding="0" cellspacing="0" style="margin-top:14px; border-top:1px solid ${BRAND.colors.border}; padding-top:12px; width:100%;"><tbody><tr>` +
    `<td style="padding-right:16px;font-size:11px;color:${BRAND.colors.muted};white-space:nowrap;">${escapeHtml(opts.legend[0])}</td>` +
    `<td style="font-size:11px;color:${BRAND.colors.muted};white-space:nowrap;">${escapeHtml(opts.legend[1])}</td>` +
    `</tr></tbody></table></div>`;
}

export function sectionHeading(text: string): string {
  return `<h2 style="margin:32px 0 8px;font-size:18px;font-weight:700;color:${BRAND.colors.navySoft};font-family:${BRAND.serifStack};padding-bottom:8px;border-bottom:1px solid rgba(241,100,95,0.25);">${escapeHtml(text)}</h2>`;
}

/** Signature block matching IDX Stalker's existing sign-off so Vern stays consistent with Navjot's other outbound tooling. */
export function signatureBlock(): string {
  const agent = getAgentIdentity();
  return `<tr><td style="padding:0 40px 36px 40px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e5e5e5; padding-top:24px;"><tbody><tr><td>` +
    `<p style="margin:0 0 2px 0; font-size:15px; font-weight:700; color:${BRAND.colors.navy};">${escapeHtml(agent.name)}</p>` +
    `<p style="margin:0 0 10px 0; font-size:13px; letter-spacing:0.5px; text-transform:uppercase; color:${BRAND.colors.gold}; font-weight:700;">${escapeHtml(agent.title)}, ${escapeHtml(agent.team)}</p>` +
    `<p style="margin:0; font-size:13px; line-height:1.6; color:#555555;">${escapeHtml(agent.phone)} &nbsp;|&nbsp; <a style="color:${BRAND.colors.navy}; text-decoration:none;" target="_blank" href="https://${escapeHtml(agent.website)}">${escapeHtml(agent.website)}</a> &nbsp;|&nbsp; ${escapeHtml(agent.email)}<br />${escapeHtml(agent.brokerage)}</p>` +
    `</td></tr></tbody></table></td></tr>`;
}

/**
 * CASL-required footer for every commercial electronic message sent from
 * Canada: identifies the sender, gives a physical mailing address, and
 * provides a working unsubscribe mechanism. Also carries the standard
 * "not soliciting under-contract clients" disclaimer real-estate boards
 * expect. This block is mandatory on every template — do not ship an
 * email without it.
 */
export function caslFooter(): string {
  const agent = getAgentIdentity();
  return `<tr><td style="background-color:${BRAND.colors.bg}; padding:24px 40px; text-align:center;">` +
    `<p style="margin:0 0 8px 0; font-size:11px; line-height:1.6; color:#888888;">${escapeHtml(agent.name)} | ${escapeHtml(agent.title)} | ${escapeHtml(agent.brokerage)} | ${escapeHtml(agent.team)} | ${escapeHtml(agent.address)}</p>` +
    `<p style="margin:0 0 8px 0; font-size:11px; color:#888888;">Not intended to solicit buyers and sellers already under contract.</p>` +
    `<p style="margin:0; font-size:11px; color:#888888;"><a style="color:#888888; text-decoration:underline;" target="_blank" href="${escapeHtml(agent.unsubscribeUrl)}">Unsubscribe</a></p>` +
    `</td></tr>`;
}
