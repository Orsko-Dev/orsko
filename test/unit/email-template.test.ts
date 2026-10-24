import { describe, expect, it } from "vitest";
import { renderMagicLinkEmail } from "../../src/account/email-template";
import fixture from "./fixtures/magic-link-email.html?raw";

const LINK = "https://orsko.dev/auth/email/callback?token=abc123";

describe("renderMagicLinkEmail", () => {
  // The sections are assembled from small builders; this pins the whole
  // document so a refactor there cannot quietly move a pixel.
  it("renders byte for byte what the committed fixture holds", () => {
    expect(renderMagicLinkEmail(LINK, "https://orsko.dev").html).toBe(fixture);
  });

  it("keeps the subject stable", () => {
    expect(renderMagicLinkEmail(LINK, "https://orsko.dev").subject).toBe("Your Orsko sign-in link");
  });

  it("points the mark at an absolute url built from the base url", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://staging.orsko.dev");
    expect(html).toContain('src="https://staging.orsko.dev/brand/orsko-mark-email.png"');
    expect(html).toContain('alt="Orsko"');
    expect(html).toContain('width="40"');
  });

  it("does not double the slash when the base url carries one", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev/");
    expect(html).toContain("https://orsko.dev/brand/orsko-mark-email.png");
    expect(html).not.toContain("https://orsko.dev//brand");
  });

  it("offers the paper mark to dark-mode clients through a picture element, with the ink img as fallback", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const picture = html.match(/<picture>[\s\S]*?<\/picture>/)?.[0] ?? "";
    expect(picture).not.toBe("");
    expect(picture).toContain('media="(prefers-color-scheme: dark)"');
    expect(picture).toContain('srcset="https://orsko.dev/brand/orsko-mark-email-paper.png"');
    // The ink img stays inside the same picture, as the fallback for clients
    // that ignore prefers-color-scheme (and thus keep the light card too).
    expect(picture).toContain('<img src="https://orsko.dev/brand/orsko-mark-email.png"');
    expect(picture).toContain('width="40"');
    expect(picture).toContain('height="40"');
    expect(picture).toContain(
      'style="display:block;width:40px;height:40px;border:0;margin:0 auto;"',
    );
    expect(picture).toContain('alt="Orsko"');
  });

  it("builds both picture urls from the passed base url", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://staging.orsko.dev");
    expect(html).toContain('srcset="https://staging.orsko.dev/brand/orsko-mark-email-paper.png"');
    expect(html).toContain('src="https://staging.orsko.dev/brand/orsko-mark-email.png"');
  });

  it("puts the link in both the button and the mono fallback", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const escaped = LINK.replace(/&/g, "&amp;");
    expect(html.split(`href="${escaped}"`).length - 1).toBe(2);
    expect(html).toContain(">Sign in</span>");
    expect(html).toContain("Or paste this into your browser:");
    expect(html).toContain("ui-monospace, SFMono-Regular, Menlo, monospace");
  });

  it("escapes an ampersand in the link", () => {
    const { html } = renderMagicLinkEmail(`${LINK}&next=%2Fme`, "https://orsko.dev");
    expect(html).toContain("token=abc123&amp;next=%2Fme");
    expect(html).not.toContain("token=abc123&next");
  });

  it("carries the ink button and one ultramarine rule, and no webfont or old green", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(html).toContain("#14171A");
    expect(html).toContain("#F1F2EE");
    expect(html.split("#2438C8").length - 1).toBe(1);
    expect(html).not.toContain("#2f6f4f");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("<link");
  });

  it("swaps the palette under a dark-mode media query", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("#0E1013");
    expect(html).toContain("#171A1E");
    expect(html).toContain("#2B2F35");
    expect(html).toContain("data-dark");
  });

  // The rule is the view's one accent; #2438C8 on the dark card is 1.9:1.
  it("lifts the accent rule to a legible ultramarine on the dark ground", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(html).toContain(".dm-accent { background-color: #7C8AFF !important; }");
    expect(html).toContain('<td data-dark class="dm-accent" style="background-color:#2438C8;');
  });

  it("keeps the button anchor and its label span un-linkified across clients", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const buttonAnchor = html.match(/<a href="[^"]*"[^>]*>\s*<span[^>]*>Sign in<\/span>\s*<\/a>/);
    expect(buttonAnchor).not.toBeNull();
    const anchorTag = buttonAnchor?.[0] ?? "";
    expect(anchorTag).toContain("text-decoration:none");
    expect(anchorTag).toContain(`color:${"#F1F2EE"}`);
    const spanTag = anchorTag.match(/<span[^>]*>/)?.[0] ?? "";
    expect(spanTag).toContain("color:#F1F2EE");
  });

  it("gives the heading its own place in the type scale", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const headingCell = html.match(/<td[^>]*>\s*Sign in to Orsko\s*<\/td>/);
    expect(headingCell).not.toBeNull();
    const headingStyle = headingCell?.[0] ?? "";
    expect(headingStyle).toContain("22px");
    expect(headingStyle).toContain("700");
  });

  it("carries the sans stack on more than a lone wrapper and the mono stack on the link line", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const sansCount =
      html.split("-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif")
        .length - 1;
    expect(sansCount).toBeGreaterThan(3);
    const monoLine = html.match(/<a href="[^"]*"[^>]*font-family:ui-monospace[^>]*>/);
    expect(monoLine).not.toBeNull();
  });

  it("never lets a double-quoted family name break out of an inline style attribute", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    const styleOpenCount = (html.match(/style="/g) ?? []).length;
    const wellFormedMatches = [...html.matchAll(/style="([^"]*)"/g)];
    expect(wellFormedMatches.length).toBe(styleOpenCount);
    for (const match of wellFormedMatches) {
      expect(match[1]).not.toContain('"');
    }
  });

  it("single-quotes the Segoe UI family name so it nests inside the double-quoted attribute", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(html).toContain("'Segoe UI'");
    expect(html).not.toContain('"Segoe UI"');
  });

  it("centres every cell in the card and keeps the raw link breakable", () => {
    const { html } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(html.split("text-align:center").length - 1).toBeGreaterThan(4);
    const linkAnchor = html.match(/<a href="[^"]*"[^>]*font-family:ui-monospace[^>]*>/);
    expect(linkAnchor).not.toBeNull();
    expect(linkAnchor?.[0] ?? "").toContain("word-break:break-all");
    expect(linkAnchor?.[0] ?? "").toContain("overflow-wrap:anywhere");
  });

  it("writes a plain-text alternative with the link and the expiry", () => {
    const { text } = renderMagicLinkEmail(LINK, "https://orsko.dev");
    expect(text).toContain(LINK);
    expect(text).toContain("expires in 15 minutes");
    expect(text).toContain("Sign in to Orsko");
    expect(text).toContain("orsko.dev");
    expect(text).not.toContain("<");
  });
});
