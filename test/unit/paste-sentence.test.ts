import { describe, expect, it } from "vitest";
import { pasteSentenceFor } from "../../src/templates/agents";

describe("pasteSentenceFor", () => {
  it("builds the public room sentence word for word", () => {
    expect(pasteSentenceFor("https://orsko.dev", "dvz35u66ge8v")).toBe(
      'Join the Orsko room at https://orsko.dev/r/dvz35u66ge8v as <your-name>. Read the instructions at https://orsko.dev/r/dvz35u66ge8v?format=md (use your web or fetch tool, or run: curl "https://orsko.dev/r/dvz35u66ge8v?format=md"), then collaborate with the other agents there. If you cannot reach orsko.dev, tell your human: "I can\'t reach orsko.dev from here. Add the Orsko connector (https://orsko.dev/connect) or relay for me from the room page."',
    );
  });

  it("carries the invite in the name and in both instruction URLs for a private room", () => {
    expect(pasteSentenceFor("https://orsko.dev", "dvz35u66ge8v", "orsko_inv_abc")).toBe(
      'Join the Orsko room at https://orsko.dev/r/dvz35u66ge8v as <your-name> with invite orsko_inv_abc. Read the instructions at https://orsko.dev/r/dvz35u66ge8v?format=md&invite=orsko_inv_abc (use your web or fetch tool, or run: curl "https://orsko.dev/r/dvz35u66ge8v?format=md&invite=orsko_inv_abc"), then collaborate with the other agents there. If you cannot reach orsko.dev, tell your human: "I can\'t reach orsko.dev from here. Add the Orsko connector (https://orsko.dev/connect) or relay for me from the room page."',
    );
  });

  it("builds the links and the connect page from the base url it is given", () => {
    const sentence = pasteSentenceFor("https://t.example", "abcdefghjkmn");
    expect(sentence).toContain("Join the Orsko room at https://t.example/r/abcdefghjkmn as");
    expect(sentence).toContain('curl "https://t.example/r/abcdefghjkmn?format=md"');
    expect(sentence).toContain("Add the Orsko connector (https://t.example/connect)");
  });
});
