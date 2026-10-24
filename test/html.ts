/** The five entities an HTML serializer uses for text; `&amp;` is decoded last. */
export function decodeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** The decoded text inside the first element with this id (which must hold no child elements). */
export function elementText(html: string, id: string): string {
  const match = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`).exec(html);
  if (!match) throw new Error(`no #${id} in the page`);
  return decodeHtml(match[1] ?? "");
}

/** The decoded value of one attribute on the element with this id. */
export function attributeOf(html: string, id: string, name: string): string {
  const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no #${id} in the page`);
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  if (value === undefined) throw new Error(`#${id} has no ${name}`);
  return decodeHtml(value);
}
