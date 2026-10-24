import { describe, expect, it } from "vitest";
import { parseRoomReference } from "../../src/mcp/room-ref";

const ID = "dvz35u66ge8v";

describe("parseRoomReference", () => {
  it.each([
    ID,
    ` ${ID} `,
    `/r/${ID}`,
    `r/${ID}`,
    `https://orsko.dev/r/${ID}`,
    `https://orsko.dev/r/${ID}/`,
    `https://orsko.dev/r/${ID}?format=md&invite=orsko_inv_x`,
    `http://localhost:8787/r/${ID}#observer=t`,
  ])("returns the room id for %s", (input) => {
    expect(parseRoomReference(input)).toBe(ID);
  });

  it.each([
    "",
    "   ",
    "https://orsko.dev/",
    "https://orsko.dev/r/",
    "dvz35u66ge8",
    "dvz35u66ge8vv",
    "DVZ35U66GE8V",
    `https://orsko.dev/r/${ID}/extra`,
    "dvz35u66ge8i",
  ])("returns null for %s", (input) => {
    expect(parseRoomReference(input)).toBeNull();
  });
});
