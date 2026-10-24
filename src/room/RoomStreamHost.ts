import { DurableObject } from "cloudflare:workers";
import { STREAM_HELLO_TIMEOUT_MS } from "../config/constants";
import type { Env } from "../env";
import { nowMs } from "../util/time";
import type { Result } from "../validation/errors";
import * as membership from "./membership";
import type { PresenceView } from "./presence";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";
import * as stream from "./stream";
import * as socket from "./stream-socket";
import type { MembersResult, PostedMessage } from "./types";

/**
 * The socket half of the room object: the upgrade, the hibernation handlers,
 * and the presence list they answer with. It is a base class rather than a
 * module because the runtime dispatches WebSocket events to methods on the
 * Durable Object itself. Everything it needs from the room proper is abstract.
 */
export abstract class RoomStreamHost extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered by the runtime itself, so a client holding the
    // socket open never wakes (or bills) the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected abstract get sql(): SqlStorage;
  protected abstract room(): RoomRow | null;
  protected abstract authenticate(token: string): Promise<Result<MemberRow>>;
  protected abstract postAs(
    member: MemberRow,
    input: { text: string; attachmentIds: readonly string[] },
  ): Result<PostedMessage>;

  /** The room's open sockets and the time: everything a member's status needs. */
  protected presenceView(excluding?: WebSocket): PresenceView {
    return { connected: socket.connectedMemberIds(this.ctx, excluding), now: nowMs() };
  }

  /**
   * Who is here, with `connected` and `status` computed from the room's open
   * stream sockets. `excluding` drops a socket whose close handler is running,
   * so a departing member is not reported as still connected.
   */
  protected membersList(excluding?: WebSocket): MembersResult {
    const row = this.room();
    if (!row) return { members: [], lastSeq: 0 };
    return membership.listPresence(this.sql, row, this.presenceView(excluding));
  }

  /**
   * Everyone still in the room. Broadcasts are filtered through it so a
   * socket whose member has left is never pushed to, whatever raced the
   * close that revoking their membership triggers.
   */
  protected presentMemberIds(): ReadonlySet<string> {
    const row = this.room();
    if (!row) return new Set<string>();
    return new Set(db.listPresentMembers(this.sql, row.room_id).map((member) => member.memberId));
  }

  protected streamContext(): stream.StreamContext {
    return {
      sql: this.sql,
      ctx: this.ctx,
      helloTimeoutMs: this.helloTimeoutMs(),
      room: () => this.room(),
      authenticate: (token) => this.authenticate(token),
      post: (member, input) => this.postAs(member, input),
      membersList: (excluding) => this.membersList(excluding),
      markRead: (memberId, since) => {
        db.advanceReadThrough(this.sql, memberId, since);
      },
      presentMemberIds: () => this.presentMemberIds(),
      touch: (memberId) => db.touchMember(this.sql, memberId, nowMs()),
      now: () => nowMs(),
    };
  }

  /** Overridable through the environment so tests need not wait ten seconds. */
  private helloTimeoutMs(): number {
    const configured = Number(this.env.STREAM_HELLO_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : STREAM_HELLO_TIMEOUT_MS;
  }

  /**
   * The room object serves exactly one request shape: the stream upgrade.
   * Everything else it does is RPC, and the Worker never forwards it here.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    if (!this.room()) return new Response("room does not exist", { status: 404 });
    return stream.acceptStream(this.streamContext());
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await stream.handleMessage(this.streamContext(), ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    stream.handleClose(this.streamContext(), ws, code);
  }

  /** A socket that failed is a socket that is gone: same bookkeeping. */
  override async webSocketError(ws: WebSocket): Promise<void> {
    stream.handleClose(this.streamContext(), ws, 1006);
  }
}
