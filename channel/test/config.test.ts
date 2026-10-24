import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_BASE_URL, loadConfig, parseRoomLocation } from "../src/config.js";

const ID = "dvz35u66ge8v";

describe("parseRoomLocation", () => {
  it("accepts a full room link and keeps its origin", () => {
    expect(parseRoomLocation(`https://orsko.dev/r/${ID}`)).toEqual({
      roomId: ID,
      baseUrl: "https://orsko.dev",
    });
  });

  it("accepts a link on another origin, including a port", () => {
    expect(parseRoomLocation(`http://127.0.0.1:8787/r/${ID}`)).toEqual({
      roomId: ID,
      baseUrl: "http://127.0.0.1:8787",
    });
  });

  it("strips query, hash, and trailing slashes", () => {
    expect(parseRoomLocation(`  https://orsko.dev/r/${ID}/?x=1#frag  `)?.roomId).toBe(ID);
  });

  it("accepts a bare path and a bare id, defaulting the origin", () => {
    expect(parseRoomLocation(`/r/${ID}`)).toEqual({ roomId: ID, baseUrl: DEFAULT_BASE_URL });
    expect(parseRoomLocation(ID)).toEqual({ roomId: ID, baseUrl: DEFAULT_BASE_URL });
  });

  it("rejects ids with the wrong length or forbidden characters", () => {
    expect(parseRoomLocation("")).toBeNull();
    expect(parseRoomLocation("short")).toBeNull();
    expect(parseRoomLocation("dvz35u66ge8vx")).toBeNull();
    // "i", "l", "o" and "1" are not in the alphabet.
    expect(parseRoomLocation("ilo1qqqqqqqq")).toBeNull();
    expect(parseRoomLocation("https://orsko.dev/rooms/dvz35u66ge8v")).toBeNull();
  });
});

describe("loadConfig", () => {
  const home = "/home/agent";

  it("builds a config from the room link and name", () => {
    const config = loadConfig(
      { ORSKO_ROOM: `https://orsko.dev/r/${ID}`, ORSKO_NAME: "alice" },
      home,
    );
    expect(config).toEqual({
      roomId: ID,
      baseUrl: "https://orsko.dev",
      roomLink: `https://orsko.dev/r/${ID}`,
      name: "alice",
      stateDir: "/home/agent/.orsko/rooms",
    });
  });

  it("lets ORSKO_BASE_URL override the origin and ORSKO_STATE_DIR the state dir", () => {
    const config = loadConfig(
      {
        ORSKO_ROOM: ID,
        ORSKO_NAME: "bot_1",
        ORSKO_BASE_URL: "http://127.0.0.1:4321/",
        ORSKO_STATE_DIR: "/tmp/state",
      },
      home,
    );
    expect(config.baseUrl).toBe("http://127.0.0.1:4321");
    expect(config.stateDir).toBe("/tmp/state");
    expect(config.roomLink).toBe(`http://127.0.0.1:4321/r/${ID}`);
  });

  it("rejects a missing or unparseable room", () => {
    expect(() => loadConfig({ ORSKO_NAME: "alice" }, home)).toThrow(ConfigError);
    expect(() => loadConfig({ ORSKO_ROOM: "nope", ORSKO_NAME: "alice" }, home)).toThrow(
      /ORSKO_ROOM/,
    );
  });

  it("rejects a missing or invalid name", () => {
    expect(() => loadConfig({ ORSKO_ROOM: ID }, home)).toThrow(/ORSKO_NAME/);
    expect(() => loadConfig({ ORSKO_ROOM: ID, ORSKO_NAME: "not a name" }, home)).toThrow(
      /ORSKO_NAME/,
    );
    expect(() => loadConfig({ ORSKO_ROOM: ID, ORSKO_NAME: "x".repeat(33) }, home)).toThrow(
      /ORSKO_NAME/,
    );
  });

  it("rejects a base url that is not http(s)", () => {
    expect(() =>
      loadConfig({ ORSKO_ROOM: ID, ORSKO_NAME: "alice", ORSKO_BASE_URL: "ftp://x.example" }, home),
    ).toThrow(/ORSKO_BASE_URL/);
  });
});

describe("loadConfig account options", () => {
  const home = "/home/agent";
  const base = { ORSKO_ROOM: ID, ORSKO_NAME: "alice" } as const;

  it("reads ORSKO_API_KEY and ORSKO_INVITE when set", () => {
    const config = loadConfig(
      { ...base, ORSKO_API_KEY: "  orsko_key_abc  ", ORSKO_INVITE: " orsko_inv_xyz " },
      home,
    );
    expect(config.apiKey).toBe("orsko_key_abc");
    expect(config.invite).toBe("orsko_inv_xyz");
  });

  it("leaves both undefined when absent or blank", () => {
    const config = loadConfig({ ...base, ORSKO_API_KEY: "   ", ORSKO_INVITE: "" }, home);
    expect(config.apiKey).toBeUndefined();
    expect(config.invite).toBeUndefined();
    expect(loadConfig(base, home).apiKey).toBeUndefined();
    expect(loadConfig(base, home).invite).toBeUndefined();
  });
});
