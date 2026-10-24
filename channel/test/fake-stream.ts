import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { FakeMember, FakeMessage, FakeOrsko } from "./fake-orsko.js";

/**
 * The stream half of the fake Orsko server: `GET /api/rooms/<id>/stream` with
 * an upgrade, the hello handshake, replay from a cursor, message and presence
 * pushes, post/ack, read, and the archive close. Only the fake needs the `ws`
 * package; the channel itself uses Node's global WebSocket.
 */

const SECRET_MARKER = "sk-live-";

interface Session {
  readonly socket: WebSocket;
  member: FakeMember | null;
}

export interface FakeStream {
  /** Refuse upgrades, so the client sees a failed connection attempt. */
  refuse: boolean;
  /** Close every session the moment it is welcomed, as a flapping server does. */
  dropOnWelcome: boolean;
  /** `hello` frames the server has received, in order. */
  readonly hellos: Array<{ token: string; since: number }>;
  /** `read` frames the server has received, in order. */
  readonly reads: Array<{ member: string; since: number }>;
  readonly openCount: number;
  /** Pushes a `state` frame to every socket; `archived` also closes them. */
  broadcastState(state: "live" | "slow" | "archived"): void;
  /** Drops every open socket, as a server restart would. */
  dropAll(code?: number): void;
  close(): Promise<void>;
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

export function attachStream(fake: FakeOrsko): FakeStream {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<Session>();
  const state = {
    refuse: false,
    dropOnWelcome: false,
    hellos: [] as Array<{ token: string; since: number }>,
    reads: [] as Array<{ member: string; since: number }>,
  };

  const membersPayload = (): unknown[] =>
    fake.members.map(({ token: _token, deliveredThrough: _delivered, ...rest }) => ({
      ...rest,
      connected: [...sessions].some((session) => session.member?.memberId === rest.memberId),
    }));

  const broadcast = (frame: unknown): void => {
    for (const session of sessions) {
      if (session.member) send(session.socket, frame);
    }
  };

  fake.onPush((message: FakeMessage) => {
    broadcast({ type: "message", message });
    // Joins and leaves reach the room as system messages, and each of them
    // changes who is present, so presence rides along with them.
    if (message.from === "system") broadcast({ type: "presence", members: membersPayload() });
  });

  function handleHello(session: Session, frame: Record<string, unknown>): void {
    const token = typeof frame.token === "string" ? frame.token : "";
    const since = typeof frame.since === "number" ? frame.since : fake.messages.length;
    state.hellos.push({ token, since });
    const member = fake.memberByToken(token);
    if (!member) {
      send(session.socket, { type: "error", code: "invalid_token", message: "bad token" });
      session.socket.close(4401, "invalid token");
      return;
    }
    session.member = member;
    send(session.socket, {
      type: "welcome",
      roomId: fake.roomId,
      you: { memberId: member.memberId, name: member.name, role: member.role },
      members: membersPayload(),
      lastSeq: fake.messages.at(-1)?.seq ?? 0,
      state: fake.mode,
    });
    for (const message of fake.messages.filter((m) => m.seq > since)) {
      send(session.socket, { type: "message", message });
    }
    broadcast({ type: "presence", members: membersPayload() });
    if (state.dropOnWelcome) session.socket.close(1001, "flapping");
  }

  function handlePost(session: Session, frame: Record<string, unknown>): void {
    const member = session.member;
    if (!member) return;
    const id = typeof frame.id === "string" ? frame.id : "";
    const text = typeof frame.text === "string" ? frame.text : "";
    const fail = (code: string, message: string): void =>
      send(session.socket, { type: "error", id, code, message });
    if (member.role === "observer") {
      fail("forbidden", "observers cannot post");
      return;
    }
    if (text.includes(SECRET_MARKER)) {
      fail("secret_detected", "that looks like a credential");
      return;
    }
    const attachmentIds = Array.isArray(frame.attachmentIds)
      ? (frame.attachmentIds as string[])
      : [];
    const unread = fake.unreadFor(member);
    const message = fake.push(member.name, text, attachmentIds);
    send(session.socket, { type: "ack", id, seq: message.seq, message, unread });
  }

  function handleFrame(session: Session, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(session.socket, { type: "error", code: "invalid_request", message: "not json" });
      session.socket.close(1003, "not json");
      return;
    }
    const frame = (parsed ?? {}) as Record<string, unknown>;
    if (frame.type === "hello") {
      handleHello(session, frame);
      return;
    }
    if (!session.member) {
      send(session.socket, { type: "error", code: "invalid_request", message: "say hello first" });
      return;
    }
    if (frame.type === "post") {
      handlePost(session, frame);
      return;
    }
    if (frame.type === "read") {
      const since = typeof frame.since === "number" ? frame.since : 0;
      session.member.readThrough = Math.max(session.member.readThrough, since);
      state.reads.push({ member: session.member.name, since });
      return;
    }
    send(session.socket, { type: "error", code: "invalid_request", message: "unknown type" });
  }

  wss.on("connection", (socket: WebSocket) => {
    const session: Session = { socket, member: null };
    sessions.add(session);
    socket.on("message", (data: Buffer) => handleFrame(session, data.toString("utf8")));
    socket.on("close", () => {
      sessions.delete(session);
      if (session.member) broadcast({ type: "presence", members: membersPayload() });
    });
    socket.on("error", () => sessions.delete(session));
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (request.url ?? "").split("?")[0];
    if (state.refuse || path !== `/api/rooms/${fake.roomId}/stream`) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (socket_) => wss.emit("connection", socket_));
  };
  fake.httpServer.on("upgrade", onUpgrade);

  return {
    get refuse() {
      return state.refuse;
    },
    set refuse(value: boolean) {
      state.refuse = value;
    },
    get dropOnWelcome() {
      return state.dropOnWelcome;
    },
    set dropOnWelcome(value: boolean) {
      state.dropOnWelcome = value;
    },
    hellos: state.hellos,
    reads: state.reads,
    get openCount() {
      return sessions.size;
    },
    broadcastState(next) {
      fake.mode = next;
      broadcast({ type: "state", state: next });
      if (next === "archived") {
        for (const session of sessions) session.socket.close(4410, "archived");
      }
    },
    dropAll(code = 1006) {
      for (const session of sessions) session.socket.close(code === 1006 ? 1001 : code);
    },
    async close() {
      fake.httpServer.off("upgrade", onUpgrade);
      for (const session of sessions) session.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
