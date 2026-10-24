/**
 * The sign-in email. Email clients drop stylesheets and webfonts, so the
 * layout is a table with inline styles and the mark is a hosted PNG; the
 * `<style>` block only adds dark mode for the clients that honour it.
 */

const SUBJECT = "Your Orsko sign-in link";

/** Brand palette, inlined because no stylesheet survives the trip. */
const LIGHT = {
  ground: "#F1F2EE",
  card: "#FBFBF9",
  rule: "#D6D9D1",
  text: "#14171A",
  muted: "#63696B",
  ultramarine: "#2438C8",
} as const;

const DARK = {
  ground: "#0E1013",
  card: "#171A1E",
  rule: "#2B2F35",
  text: "#F1F2EE",
  muted: "#8C9298",
  // The accent lifted for the dark ground: #2438C8 on #171A1E is only 1.9:1.
  ultramarine: "#7C8AFF",
} as const;

const FONT_PROSE = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const HEADING = "Sign in to Orsko";
const LEDE = "This link signs you in once and expires in 15 minutes.";
const BUTTON = "Sign in";
const FALLBACK = "Or paste this into your browser:";
const FOOTER =
  "You are receiving this because someone asked for a sign-in link for this address. If that was not you, ignore this email.";
const WORDMARK = "orsko.dev";

/** Escapes the five characters that change meaning inside HTML text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Drops any trailing slash so `${base}/path` never doubles it. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function renderDarkModeStyles(): string {
  return `<style>
      @media (prefers-color-scheme: dark) {
        .dm-ground { background-color: ${DARK.ground} !important; }
        .dm-card { background-color: ${DARK.card} !important; border-color: ${DARK.rule} !important; }
        .dm-text { color: ${DARK.text} !important; }
        .dm-muted { color: ${DARK.muted} !important; }
        .dm-rule { background-color: ${DARK.rule} !important; }
        .dm-accent { background-color: ${DARK.ultramarine} !important; }
        .dm-button { background-color: ${LIGHT.ground} !important; }
        .dm-button a { background-color: ${LIGHT.ground} !important; color: ${LIGHT.text} !important; }
        .dm-button a span { color: ${LIGHT.text} !important; }
      }
    </style>`;
}

/** The card head: charset, colour-scheme hints, and the dark-mode block. */
function renderHead(): string {
  return `  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>${HEADING}</title>
    ${renderDarkModeStyles()}
  </head>`;
}

/**
 * The mark, and under it the single ultramarine rule this view is allowed.
 *
 * The ink mark is unreadable on the dark card (`#14171A` on `#171A1E` is a
 * ~1.03:1 contrast), so a `<picture>` offers the paper mark for dark mode.
 * A client that honours `prefers-color-scheme` (Apple Mail, iOS Mail,
 * Outlook for macOS) also honours `<picture>`, so it gets the dark card
 * together with the paper mark; a client that ignores the media query
 * keeps the light card together with the ink `<img>` fallback. The two
 * never mismatch.
 */
function renderHeader(markUrl: string, markUrlDark: string): string {
  return `            <tr>
              <td align="center" style="padding:32px 32px 0 32px;text-align:center;">
                <picture>
                  <source media="(prefers-color-scheme: dark)" srcset="${markUrlDark}">
                  <img src="${markUrl}" width="40" height="40" alt="Orsko" style="display:block;width:40px;height:40px;border:0;margin:0 auto;">
                </picture>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 32px 0 32px;text-align:center;">
                <table role="presentation" align="center" width="48" cellpadding="0" cellspacing="0" border="0" style="width:48px;margin:0 auto;">
                  <tr><td data-dark class="dm-accent" style="background-color:${LIGHT.ultramarine};height:2px;line-height:2px;font-size:0;">&nbsp;</td></tr>
                </table>
              </td>
            </tr>`;
}

/** The heading and the one-sentence lede that says what the link does. */
function renderCopy(): string {
  return `            <tr>
              <td align="center" data-dark class="dm-text" style="padding:20px 32px 0 32px;text-align:center;font-family:${FONT_PROSE};font-size:22px;font-weight:700;line-height:1.3;letter-spacing:-0.02em;color:${LIGHT.text};">
                ${HEADING}
              </td>
            </tr>
            <tr>
              <td align="center" data-dark class="dm-text" style="padding:12px 32px 0 32px;text-align:center;font-family:${FONT_PROSE};font-size:16px;line-height:1.6;color:${LIGHT.text};">
                ${LEDE}
              </td>
            </tr>`;
}

/** The ink-filled button. Its colours are inline so no client can lose them. */
function renderButton(href: string): string {
  return `            <tr>
              <td align="center" style="padding:24px 32px 0 32px;text-align:center;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                  <tr>
                    <td data-dark class="dm-button" bgcolor="${LIGHT.text}" style="padding:12px 22px;background-color:${LIGHT.text};border-radius:6px;">
                      <a href="${href}" style="display:block;font-family:${FONT_PROSE};font-size:16px;font-weight:600;line-height:1;color:${LIGHT.ground};text-decoration:none;">
                        <span style="font-family:${FONT_PROSE};color:${LIGHT.ground};text-decoration:none;">${BUTTON}</span>
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/** The raw URL in mono, for the clients and humans that will not press a button. */
function renderFallback(href: string): string {
  return `            <tr>
              <td align="center" data-dark class="dm-muted" style="padding:24px 32px 0 32px;text-align:center;font-family:${FONT_PROSE};font-size:14px;line-height:1.6;color:${LIGHT.muted};">
                ${FALLBACK}
              </td>
            </tr>
            <tr>
              <td align="center" data-dark class="dm-text" style="padding:8px 32px 0 32px;text-align:center;font-family:${FONT_MONO};font-size:13px;line-height:1.6;color:${LIGHT.text};word-break:break-all;overflow-wrap:anywhere;">
                <a href="${href}" data-dark class="dm-text" style="font-family:${FONT_MONO};color:${LIGHT.text};text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${href}</a>
              </td>
            </tr>`;
}

/** The hairline, the why-am-I-getting-this note, and the wordmark. */
function renderFooter(): string {
  return `            <tr>
              <td style="padding:28px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr><td data-dark class="dm-rule" style="background-color:${LIGHT.rule};height:1px;line-height:1px;font-size:0;border:0;">&nbsp;</td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" data-dark class="dm-muted" style="padding:16px 32px 8px 32px;text-align:center;font-family:${FONT_PROSE};font-size:13px;line-height:1.6;color:${LIGHT.muted};">
                ${FOOTER}
              </td>
            </tr>
            <tr>
              <td align="center" data-dark class="dm-muted" style="padding:0 32px 32px 32px;text-align:center;font-family:${FONT_PROSE};font-size:13px;line-height:1.6;color:${LIGHT.muted};">
                ${WORDMARK}
              </td>
            </tr>`;
}

/** The centred card, section by section, on the paper ground. */
function renderHtml(link: string, baseUrl: string): string {
  const href = escapeHtml(link);
  const base = normalizeBase(baseUrl);
  const markUrl = escapeHtml(`${base}/brand/orsko-mark-email.png`);
  const markUrlDark = escapeHtml(`${base}/brand/orsko-mark-email-paper.png`);
  return `<!doctype html>
<html lang="en">
${renderHead()}
  <body data-dark style="margin:0;padding:0;background-color:${LIGHT.ground};" class="dm-ground">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-dark class="dm-ground" style="background-color:${LIGHT.ground};margin:0;padding:24px 12px;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" data-dark class="dm-card" style="width:100%;max-width:600px;background-color:${LIGHT.card};border:1px solid ${LIGHT.rule};border-radius:6px;">
${renderHeader(markUrl, markUrlDark)}
${renderCopy()}
${renderButton(href)}
${renderFallback(href)}
${renderFooter()}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText(link: string): string {
  return [HEADING, "", LEDE, "", link, "", FOOTER, "", WORDMARK].join("\n");
}

/**
 * Renders the sign-in email in both parts. `baseUrl` is the public origin the
 * mark is served from; the link is used verbatim in the button and the
 * plain-text fallback.
 */
export function renderMagicLinkEmail(
  link: string,
  baseUrl: string,
): { subject: string; html: string; text: string } {
  return { subject: SUBJECT, html: renderHtml(link, baseUrl), text: renderText(link) };
}
