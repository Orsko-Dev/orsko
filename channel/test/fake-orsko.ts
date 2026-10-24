import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Orsko Worker: join, members, the long-poll, posting, and
 * attachment upload, with a controllable message queue and mode so tests can
 * drive live/slow/archived and failure paths.
 */

export interface FakeMessage {
  id: string;
  seq: number;
  roomId: string;
  from: string;
  text: string;
  attachmentIds: string[];
  createdAt: string;
}

export interface FakeMember {
  memberId: string;
  name: string;
  role: string;
  token: string;
  readThrough: number;
  /** Highest seq a join or poll handed this member, as the Worker records it. */
  deliveredThrough: number;
  lastSeenAt: string | null;
  joinedAt: string;
  leftAt: string | null;
}

export interface FakeUpload {
  filename: string;
  contentType: string;
  size: number;
  body: Buffer;
  attachmentId: string;
}

export interface FakeOrskoOptions {
  readonly roomId?: string;
}

interface Waiter {
  readonly since: number;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
}

const SECRET_MARKER = "sk-live-";

export class FakeOrsko {
  readonly roomId: string;
  readonly messages: FakeMessage[] = [];
  readonly members: FakeMember[] = [];
  readonly uploads: FakeUpload[] = [];
  readonly pollRequests: Array<{ since: number; waitSeconds: number }> = [];
  /** The `X-Orsko-Idempotency-Key` of every HTTP post, in order (null: absent). */
  readonly postKeys: Array<string | null> = [];
  /** Every join request: its name, its `invite` field, and its API key header. */
  readonly joinRequests: Array<{
    name: string;
    invite: string | null;
    apiKey: string | null;
  }> = [];

  mode: "live" | "slow" | "archived" = "live";
  retryAfterSeconds = 30;
  /** When > 0, the next N poll requests fail with a 500 (network-ish failure). */
  failPolls = 0;
  /** When true, GET /members answers 401 so the channel must re-join. */
  rejectTokens = false;
  /** The latest outcome recorded through PUT /outcome, or null. */
  outcome: { text: string; by: string; at: string } | null = null;

  private readonly server: http.Server;
  private waiters: Waiter[] = [];
  private pushListeners: Array<(message: FakeMessage) => void> = [];
  private port = 0;

  constructor(options: FakeOrskoOptions = {}) {
    this.roomId = options.roomId ?? "dvz35u66ge8v";
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.send(res, 500, { error: { code: "internal", message: String(error) } });
      });
    });
  }

  /** The underlying HTTP server, so the fake stream can take its upgrades. */
  get httpServer(): http.Server {
    return this.server;
  }

  /** Called for every appended message, however it was appended. */
  onPush(listener: (message: FakeMessage) => void): void {
    this.pushListeners = [...this.pushListeners, listener];
  }

  memberByToken(token: string): FakeMember | null {
    return this.members.find((member) => member.token === token) ?? null;
  }

  /**
   * Messages from others the member was neither handed nor marked read, as the
   * Worker counts them for `unread`.
   */
  unreadFor(member: FakeMember): number {
    const cursor = Math.max(member.readThrough, member.deliveredThrough);
    return this.messages.filter(
      (m) => m.seq > cursor && m.from !== member.name && m.from !== "system",
    ).length;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters = [];
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Idle keep-alive sockets would hold the close open for seconds otherwise.
    this.server.closeAllConnections();
    await closed;
  }

  /** Appends a message as `from` and wakes every long poll waiting for it. */
  push(from: string, text: string, attachmentIds: string[] = []): FakeMessage {
    const message: FakeMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      seq: this.messages.length + 1,
      roomId: this.roomId,
      from,
      text,
      attachmentIds,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    const waking = this.waiters;
    this.waiters = [];
    for (const waiter of waking) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    for (const listener of this.pushListeners) listener(message);
    return message;
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  private memberFor(req: http.IncomingMessage): FakeMember | null {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return this.members.find((m) => m.token === token) ?? null;
  }

  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const prefix = `/api/rooms/${this.roomId}`;
    if (!url.pathname.startsWith(prefix)) {
      this.send(res, 404, { error: { code: "room_not_found", message: "no such room" } });
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    if (req.method === "POST" && rest === "/members") return this.join(req, res);
    if (req.method === "GET" && rest === "/members") return this.listMembers(req, res);
    if (req.method === "GET" && rest === "/messages") return this.poll(req, res, url);
    if (req.method === "POST" && rest === "/messages") return this.postMessage(req, res);
    if (req.method === "PUT" && rest === "/attachments") return this.upload(req, res);
    if (req.method === "PUT" && rest === "/outcome") return this.putOutcome(req, res);
    if (req.method === "POST" && rest === "/leave") {
      res.writeHead(204);
      res.end();
      return;
    }
    this.send(res, 404, { error: { code: "invalid_request", message: "unknown route" } });
  }

  private async join(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = JSON.parse((await this.body(req)).toString("utf8")) as {
      name?: string;
      role?: string;
      invite?: string;
    };
    const name = parsed.name ?? "";
    const apiKey = req.headers["x-orsko-key"];
    this.joinRequests.push({
      name,
      invite: parsed.invite ?? null,
      apiKey: typeof apiKey === "string" ? apiKey : null,
    });
    if (this.members.some((m) => m.name === name && m.leftAt === null)) {
      this.send(res, 409, { error: { code: "name_taken", message: "name taken" } });
      return;
    }
    const member: FakeMember = {
      memberId: `m_${randomUUID().slice(0, 8)}`,
      name,
      role: parsed.role ?? "agent",
      token: `tok_${randomUUID()}`,
      readThrough: 0,
      deliveredThrough: 0,
      lastSeenAt: null,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    };
    this.members.push(member);
    this.push("system", `${name} joined`);
    const recent = this.messages.slice(-20);
    member.deliveredThrough = recent.at(-1)?.seq ?? 0;
    this.send(res, 201, {
      memberId: member.memberId,
      name: member.name,
      role: member.role,
      token: member.token,
      recent,
      nextSince: recent.at(-1)?.seq ?? 0,
    });
  }

  private listMembers(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.rejectTokens || !this.memberFor(req)) {
      this.send(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return;
    }
    this.send(res, 200, {
      members: this.members.map(({ token: _token, deliveredThrough: _delivered, ...rest }) => rest),
      lastSeq: this.messages.at(-1)?.seq ?? 0,
    });
  }

  private poll(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const member = this.memberFor(req);
    if (this.rejectTokens || !member) {
      this.send(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return;
    }
    if (this.failPolls > 0) {
      this.failPolls -= 1;
      this.send(res, 500, { error: { code: "internal", message: "boom" } });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    const waitSeconds = Number(url.searchParams.get("waitSeconds") ?? "0");
    this.pollRequests.push({ since, waitSeconds });
    const answer = (): void => {
      const messages = this.messages.filter((m) => m.seq > since);
      const nextSince = messages.at(-1)?.seq ?? since;
      member.deliveredThrough = Math.max(member.deliveredThrough, nextSince);
      const body: Record<string, unknown> = { messages, nextSince, mode: this.mode };
      if (this.mode === "slow") body.retryAfterSeconds = this.retryAfterSeconds;
      this.send(res, 200, body);
    };
    const ready = this.messages.some((m) => m.seq > since);
    if (ready || waitSeconds <= 0 || this.mode !== "live") {
      answer();
      return;
    }
    const timer = setTimeout(() => {
      this.waiters = this.waiters.filter((w) => w.timer !== timer);
      answer();
    }, waitSeconds * 1000);
    this.waiters = [...this.waiters, { since, resolve: answer, timer }];
    res.on("close", () => {
      clearTimeout(timer);
      this.waiters = this.waiters.filter((w) => w.timer !== timer);
    });
  }

  private async postMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const member = this.memberFor(req);
    if (!member) {
      this.send(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return;
    }
    const parsed = JSON.parse((await this.body(req)).toString("utf8")) as {
      text?: string;
      attachmentIds?: string[];
    };
    const header = req.headers["x-orsko-idempotency-key"];
    this.postKeys.push(typeof header === "string" ? header : null);
    const text = parsed.text ?? "";
    if (text.includes(SECRET_MARKER)) {
      this.send(res, 422, {
        error: { code: "secret_detected", message: "that looks like a credential" },
      });
      return;
    }
    const unread = this.unreadFor(member);
    this.send(res, 201, { ...this.push(member.name, text, parsed.attachmentIds ?? []), unread });
  }

  private async putOutcome(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const member = this.memberFor(req);
    if (!member) {
      this.send(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return;
    }
    const parsed = JSON.parse((await this.body(req)).toString("utf8")) as { text?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (member.role === "observer") {
      this.send(res, 403, {
        error: { code: "forbidden", message: "observers cannot record the outcome" },
      });
      return;
    }
    if (text.length === 0 || text.length > 2000) {
      this.send(res, 400, { error: { code: "invalid_request", message: "text: bad length" } });
      return;
    }
    this.outcome = { text, by: member.name, at: new Date().toISOString() };
    this.push("system", `${member.name} recorded the outcome`);
    this.send(res, 200, { outcome: this.outcome });
  }

  private async upload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const member = this.memberFor(req);
    if (!member) {
      this.send(res, 401, { error: { code: "invalid_token", message: "bad token" } });
      return;
    }
    const body = await this.body(req);
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared !== body.length) {
      this.send(res, 400, {
        error: { code: "invalid_request", message: "content-length did not match body size" },
      });
      return;
    }
    const upload: FakeUpload = {
      filename: String(req.headers["x-filename"] ?? ""),
      contentType: String(req.headers["content-type"] ?? ""),
      size: body.length,
      body,
      attachmentId: `a_${randomUUID().slice(0, 8)}`,
    };
    this.uploads.push(upload);
    this.send(res, 201, {
      attachmentId: upload.attachmentId,
      filename: upload.filename,
      size: upload.size,
      contentType: upload.contentType,
      uploadedBy: member.name,
      createdAt: new Date().toISOString(),
    });
  }
}

export async function startFakeOrsko(options: FakeOrskoOptions = {}): Promise<FakeOrsko> {
  const fake = new FakeOrsko(options);
  await fake.start();
  return fake;
}
