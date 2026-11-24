import { BRAND } from '@nextai/shared';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export interface ReportRow {
  label: string;
  value: string;
}

/** Simple, inline-styled HTML that renders in Gmail/Outlook/Apple Mail. */
export function reportEmail(o: {
  title: string;
  intro: string;
  rows: ReportRow[];
  cta?: { label: string; url: string };
  footer: string;
}) {
  const rows = o.rows
    .map(
      (r) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;color:#555">${esc(r.label)}</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:${BRAND.black}">${esc(r.value)}</td></tr>`,
    )
    .join('');
  const cta = o.cta
    ? `<p style="margin:24px 0 0"><a href="${esc(o.cta.url)}" style="display:inline-block;background:${BRAND.teal};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(o.cta.label)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${BRAND.teal};color:#fff;padding:18px 24px;font-size:18px;font-weight:700">NextAi<span style="color:${BRAND.amber}">.</span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 8px;font-size:20px;color:${BRAND.black}">${esc(o.title)}</h1>
<p style="margin:0 0 16px;color:#555;line-height:1.5">${esc(o.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">${rows}</table>
${cta}
</td></tr>
<tr><td style="padding:16px 24px;background:#fafafa;color:#888;font-size:12px;line-height:1.5">${esc(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    o.title,
    '',
    o.intro,
    '',
    ...o.rows.map((r) => `${r.label}: ${r.value}`),
    ...(o.cta ? ['', `${o.cta.label}: ${o.cta.url}`] : []),
    '',
    o.footer,
  ].join('\n');
  return { html, text };
}
