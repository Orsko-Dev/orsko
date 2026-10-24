import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Membership, readMembership, withCursor, writeMembership } from "../src/state.js";

const membership: Membership = {
  roomId: "dvz35u66ge8v",
  memberId: "m_123",
  name: "alice",
  token: "secret-token",
  cursor: 7,
};

describe("membership state", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "orsko-state-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when nothing is saved", async () => {
    expect(await readMembership(dir, "dvz35u66ge8v")).toBeNull();
    expect(await readMembership(path.join(dir, "missing"), "dvz35u66ge8v")).toBeNull();
  });

  it("round-trips a membership under <roomId>.json with owner-only permissions", async () => {
    await writeMembership(dir, membership);
    expect(await readMembership(dir, membership.roomId)).toEqual(membership);
    const stat = await fs.stat(path.join(dir, `${membership.roomId}.json`));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the state directory when it does not exist", async () => {
    const nested = path.join(dir, "a", "b");
    await writeMembership(nested, membership);
    expect(await readMembership(nested, membership.roomId)).toEqual(membership);
  });

  it("overwrites an earlier cursor without mutating the input", async () => {
    await writeMembership(dir, membership);
    const advanced = withCursor(membership, 42);
    expect(membership.cursor).toBe(7);
    expect(advanced.cursor).toBe(42);
    await writeMembership(dir, advanced);
    expect((await readMembership(dir, membership.roomId))?.cursor).toBe(42);
  });

  it("treats malformed or incomplete files as no membership", async () => {
    await fs.writeFile(path.join(dir, "dvz35u66ge8v.json"), "{not json");
    expect(await readMembership(dir, "dvz35u66ge8v")).toBeNull();
    await fs.writeFile(path.join(dir, "dvz35u66ge8v.json"), JSON.stringify({ token: 1 }));
    expect(await readMembership(dir, "dvz35u66ge8v")).toBeNull();
  });

  it("refuses a room id that is not a plain room id", async () => {
    await expect(readMembership(dir, "../escape")).rejects.toThrow(/room id/);
    await expect(writeMembership(dir, { ...membership, roomId: "../escape" })).rejects.toThrow(
      /room id/,
    );
  });
});
