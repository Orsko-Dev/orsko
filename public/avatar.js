// Deterministic robot avatars. Pure, no network, shared by the Worker and the browser.
const HEADS = [
  'M12 14h40a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z',
  'M32 8a24 24 0 1 1 0 48 24 24 0 0 1 0-48z',
  'M10 16h44l4 34H6z',
  'M16 10h32a10 10 0 0 1 10 10v24a10 10 0 0 1-10 10H16A10 10 0 0 1 6 44V20a10 10 0 0 1 10-10z',
  'M8 20 32 8l24 12v24L32 56 8 44z',
  'M14 12h36a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z',
];
const EYES = [
  ['googly', '<circle cx="23" cy="30" r="6" fill="#FBFBF9"/><circle cx="41" cy="30" r="6" fill="#FBFBF9"/><circle cx="25" cy="31" r="2.5" fill="#14171A"/><circle cx="39" cy="29" r="2.5" fill="#14171A"/>', 3],
  ['sleepy', '<path d="M17 31h12M35 31h12" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 1],
  ['monocle', '<circle cx="23" cy="30" r="3" fill="#14171A"/><circle cx="41" cy="30" r="7" fill="none" stroke="#14171A" stroke-width="2"/><circle cx="41" cy="30" r="3" fill="#14171A"/><path d="M48 30v10" stroke="#14171A" stroke-width="1.5"/>', 1],
  ['visor', '<rect x="14" y="25" width="36" height="10" rx="5" fill="#14171A"/><rect x="18" y="28" width="10" height="4" rx="2" fill="#8C9298"/>', 1],
  ['dots', '<circle cx="24" cy="30" r="3" fill="#14171A"/><circle cx="40" cy="30" r="3" fill="#14171A"/>', 3],
  ['wide', '<circle cx="23" cy="30" r="7" fill="#FBFBF9"/><circle cx="41" cy="30" r="7" fill="#FBFBF9"/><circle cx="23" cy="30" r="3" fill="#14171A"/><circle cx="41" cy="30" r="3" fill="#14171A"/>', 2],
  ['wink', '<circle cx="23" cy="30" r="3" fill="#14171A"/><path d="M36 30h10" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 1],
  ['cross', '<path d="M20 27l6 6M26 27l-6 6M38 27l6 6M44 27l-6 6" stroke="#14171A" stroke-width="2.5" stroke-linecap="round"/>', 1],
];
const MOUTHS = [
  ['grin', '<path d="M22 42q10 8 20 0" fill="none" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 4],
  ['flat', '<path d="M24 43h16" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 2],
  ['worried', '<path d="M22 46q10-7 20 0" fill="none" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 1],
  ['gasp', '<ellipse cx="32" cy="44" rx="5" ry="6" fill="#14171A"/>', 1],
  ['tongue', '<path d="M22 42q10 8 20 0" fill="none" stroke="#14171A" stroke-width="3"/><path d="M30 44h6v5a3 3 0 0 1-6 0z" fill="#8C9298"/>', 1],
  ['zigzag', '<path d="M22 44l4-4 4 4 4-4 4 4 4-4" fill="none" stroke="#14171A" stroke-width="2.5"/>', 1],
  ['smirk', '<path d="M24 43q8 4 16-2" fill="none" stroke="#14171A" stroke-width="3" stroke-linecap="round"/>', 2],
  ['o', '<circle cx="32" cy="44" r="4" fill="none" stroke="#14171A" stroke-width="3"/>', 1],
];
const ANTENNAE = [
  '',
  '<path d="M32 14V5" stroke="#14171A" stroke-width="2"/><circle cx="32" cy="4" r="3" fill="#63696B"/>',
  '<path d="M22 14l-4-9M42 14l4-9" stroke="#14171A" stroke-width="2"/><circle cx="18" cy="4" r="2.5" fill="#63696B"/><circle cx="46" cy="4" r="2.5" fill="#63696B"/>',
  '<path d="M32 14q-8-6-6-12" fill="none" stroke="#14171A" stroke-width="2"/><circle cx="26" cy="2.5" r="2.5" fill="#63696B"/>',
  '<rect x="29" y="4" width="6" height="10" rx="3" fill="#14171A"/>',
];
const ACCESSORIES = [
  ['none', '', 6],
  ['hat', '<rect x="18" y="6" width="28" height="9" rx="2" fill="#14171A"/><rect x="24" y="0" width="16" height="8" rx="2" fill="#14171A"/>', 1],
  ['bow', '<path d="M22 52l10 4 10-4-10-4z" fill="#63696B"/><circle cx="32" cy="52" r="2" fill="#14171A"/>', 1],
];
// Near-monochrome, muted toward ink and paper so a row of avatars reads as
// data rather than decoration. Same count and order as before, so every name
// keeps the avatar it had.
const PALETTES = [
  ['#DCE3EC', '#33414F'], ['#E9E2D8', '#4C4238'], ['#DFE7DF', '#3B4A40'], ['#EDE0E4', '#4E3B42'],
  ['#E2DFEC', '#403A50'], ['#EDE9D9', '#4A452F'], ['#DCE6EC', '#33454F'], ['#EDE3DA', '#4F4034'],
  ['#DFE9E2', '#374A42'], ['#EDE1DE', '#4E3B38'], ['#E6E7E3', '#3F4448'], ['#DDE2EA', '#333D4C'],
];
const OBSERVER_PALETTES = [['#E6E7E3', '#41474A'], ['#DFE5EC', '#38434F'], ['#EDE6DD', '#4B4136'], ['#DFE8E1', '#3A4941']];

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function seedFor(name, roomId) {
  const key = roomId + ':' + String(name).toLowerCase();
  const a = fnv1a(key), b = fnv1a(key + '#2');
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'));
}
function rng(seedHex) {
  let s = parseInt(seedHex.slice(0, 8), 16) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function weighted(list, r) {
  const total = list.reduce((n, item) => n + (item[2] || 1), 0);
  let x = r() * total;
  for (const item of list) { x -= item[2] || 1; if (x <= 0) return item; }
  return list[list.length - 1];
}
function pick(list, r) { return list[Math.floor(r() * list.length)]; }
function wrap(inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img">' + inner + '</svg>';
}
export function avatarFor(name, roomId) {
  const seed = seedFor(name, roomId);
  const r = rng(seed);
  const [fill, stroke] = pick(PALETTES, r);
  const head = pick(HEADS, r);
  const eyes = weighted(EYES, r)[1];
  const mouth = weighted(MOUTHS, r)[1];
  const antenna = pick(ANTENNAE, r);
  const acc = weighted(ACCESSORIES, r)[1];
  const svg = wrap(antenna + '<path d="' + head + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2.5"/>' + eyes + mouth + acc);
  return { seed, svg };
}
export function observerAvatarFor(name, roomId) {
  const seed = seedFor('observer:' + name, roomId);
  const r = rng(seed);
  const [fill, stroke] = pick(OBSERVER_PALETTES, r);
  const initial = String(name).replace(/^viewer-/, '').slice(0, 2).toUpperCase() || '?';
  const svg = wrap('<circle cx="32" cy="32" r="28" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2.5"/>' +
    '<text x="32" y="39" text-anchor="middle" font-family="Manrope, system-ui, sans-serif" font-size="20" font-weight="600" fill="' + stroke + '">' + initial.replace(/[<>&]/g, '') + '</text>');
  return { seed, svg };
}
export function systemAvatarSvg() {
  return wrap('<rect x="10" y="10" width="44" height="44" rx="10" fill="#E4E6E0"/><circle cx="32" cy="32" r="6" fill="#63696B"/>');
}
if (typeof window !== 'undefined') window.orskoAvatar = { avatarFor, observerAvatarFor, systemAvatarSvg };
