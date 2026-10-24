import { SELF } from "cloudflare:test";
import { vi } from "vitest";

export const BASE = "http://example.com";

/**
 * Signs a fresh user in through the magic-link flow: mocks the Resend call
 * to capture the link, posts the sign-in email, then follows the callback.
 * Returns the `set-cookie` header value (name=value only) for the new
 * session, ready to use as a `cookie` header in subsequent requests.
 */
export async function signInViaMagicLink(email: string): Promise<string> {
  let link = "";
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "https://api.resend.com/emails") {
      link = String(JSON.parse(String(init?.body)).text).match(/https?:\/\/\S+/)?.[0] ?? "";
      return Response.json({ id: "e" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await SELF.fetch(`${BASE}/auth/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ email }),
  });
  spy.mockRestore();
  const u = new URL(link);
  const cb = await SELF.fetch(`${BASE}${u.pathname}${u.search}`, { redirect: "manual" });
  return cb.headers.get("set-cookie")?.split(";")[0] ?? "";
}

export async function createRoomViaHttp(
  purpose?: string,
): Promise<{ roomId: string; url: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `10.0.0.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify(purpose ? { purpose } : {}),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { roomId: string; url: string };
}

export async function joinViaHttp(
  roomId: string,
  name: string,
  role: "agent" | "observer" = "agent",
): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, role }),
  });
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

export function authHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

export interface StreamFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

/**
 * A test client for the room stream. Frames are buffered as they arrive so a
 * test can await them in order without racing the socket.
 */
export interface StreamClient {
  send(frame: unknown): void;
  sendRaw(text: string): void;
  next(): Promise<StreamFrame>;
  nextOf(type: string): Promise<StreamFrame>;
  /** Every frame received so far and not yet consumed, clearing the buffer. */
  drain(): StreamFrame[];
  closed(): Promise<CloseInfo>;
  /**
   * Closes the socket and waits for the close to complete. The workers test
   * pool will not exit while a socket is still closing, so tests must await
   * this rather than fire the close and move on.
   */
  close(): Promise<void>;
}

/**
 * Upgrades are metered per IP, so every open gets its own address unless a
 * test is deliberately exercising the limiter with a fixed one.
 */
export function randomIp(): string {
  return `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

export async function openStreamResponse(roomId: string, ip = randomIp()): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/stream`, {
    headers: { Upgrade: "websocket", "cf-connecting-ip": ip },
  });
}

/**
 * Every client this file has opened. The workers test pool stays alive while
 * a socket is open, so tests close them all after each case.
 */
const openClients = new Set<StreamClient>();

export async function closeAllStreams(): Promise<void> {
  const closing = [...openClients].map((client) => client.close());
  openClients.clear();
  await Promise.all(closing);
  // Give the runtime a turn to finish tearing the sockets down: the workers
  // test pool will not exit while one is still closing.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

export async function openStream(roomId: string): Promise<StreamClient> {
  const res = await openStreamResponse(roomId);
  if (res.status !== 101) throw new Error(`stream failed: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on 101 response");
  return adoptStream(ws);
}

/** Wraps a raw client socket, tracking it so afterEach can close it. */
export function adoptStream(ws: WebSocket): StreamClient {
  const frames: StreamFrame[] = [];
  const waiters: ((frame: StreamFrame) => void)[] = [];
  let close: CloseInfo | null = null;
  const closeWaiters: ((info: CloseInfo) => void)[] = [];

  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as StreamFrame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  ws.addEventListener("close", (event: CloseEvent) => {
    close = { code: event.code, reason: event.reason };
    // A client socket does not answer a close frame on its own, and the
    // workers test pool will not exit while one is left half-closed.
    try {
      ws.close(1000, "acknowledged");
    } catch {
      // Already fully closed.
    }
    for (const waiter of closeWaiters.splice(0)) waiter(close);
  });

  const next = (): Promise<StreamFrame> => {
    const buffered = frames.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<StreamFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 5000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };

  const client: StreamClient = {
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (text) => ws.send(text),
    next,
    drain: () => frames.splice(0),
    nextOf: async (type) => {
      for (;;) {
        const frame = await next();
        if (frame.type === type) return frame;
      }
    },
    closed: () =>
      close !== null
        ? Promise.resolve(close)
        : new Promise<CloseInfo>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
            closeWaiters.push((info) => {
              clearTimeout(timer);
              resolve(info);
            });
          }),
    close: async () => {
      if (close !== null) return;
      try {
        ws.close(1000, "test done");
      } catch {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        closeWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  openClients.add(client);
  return client;
}
