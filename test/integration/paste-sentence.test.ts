import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pasteSentenceFor } from "../../src/templates/agents";
import { BASE, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

interface CreatedRoom {
  readonly roomId: string;
  readonly private: boolean;
  readonly pasteSentence: string | null;
}

async function create(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<CreatedRoom> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `10.9.1.${Math.floor(Math.random() * 250)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreatedRoom;
}

describe("the paste sentence in API responses", () => {
  it("comes back from creating a public room, built by the server", async () => {
    const room = await create({});
    expect(room.pasteSentence).toBe(pasteSentenceFor(env.PUBLIC_BASE_URL, room.roomId));
  });

  it("is null for a private room, whose sentence arrives with its first invite", async () => {
    const owner = await signInViaMagicLink("paste-private@example.com");
    const room = await create({ private: true }, { cookie: owner });
    expect(room.pasteSentence).toBeNull();
    const minted = await SELF.fetch(`${BASE}/api/rooms/${room.roomId}/invites`, {
      method: "POST",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(minted.status).toBe(201);
    const { token, pasteSentence } = (await minted.json()) as {
      token: string;
      pasteSentence: string;
    };
    expect(pasteSentence).toBe(pasteSentenceFor(env.PUBLIC_BASE_URL, room.roomId, token));
  });
});
