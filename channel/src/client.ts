/** Typed HTTP client for the Orsko room API. Mirrors the Worker's shapes. */

export interface Message {
  readonly id: string;
  readonly seq: number;
  readonly roomId: string;
  readonly from: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: string;
}

/**
 * A message as the room hands it back to its poster. `unread` is how many
 * messages from others the poster had not been handed or marked read; it is
 * absent only when the post was reconciled from a read rather than acked.
 */
export interface PostedMessage extends Message {
  readonly unread?: number;
}

/** The room's recorded outcome. */
export interface Outcome {
  readonly text: string;
  readonly by: string;
  readonly at: string;
}

export interface Member {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly readThrough: number;
  readonly lastSeenAt: string | null;
  readonly joinedAt?: string;
  readonly leftAt?: string | null;
}

export interface MembersResult {
  readonly members: readonly Member[];
  readonly lastSeq: number;
}

export interface JoinResult {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly token: string;
  readonly recent: readonly Message[];
  readonly nextSince: number;
}

export type PollMode = "live" | "slow" | "archived";

export interface PollResult {
  readonly messages: readonly Message[];
  readonly nextSince: number;
  readonly mode: PollMode;
  readonly retryAfterSeconds?: number;
}

export interface AttachmentResult {
  readonly attachmentId: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

/** The API answered with `{ error: { code, message } }`. */
export class OrskoApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "OrskoApiError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never produced a response: DNS, connection, timeout, abort. */
export class OrskoNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrskoNetworkError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The only request bodies this client sends. */
export type RequestBody = string | Uint8Array;

export interface OrskoClientOptions {
  readonly baseUrl: string;
  readonly roomId: string;
  readonly token?: string;
  /**
   * A personal Orsko API key. Sent as `X-Orsko-Key` on the calls that can
   * link a room to an account (join today, room creation when this client
   * grows one). It is an account credential, not a member token: it never
   * replaces the `Authorization` header.
   */
  readonly apiKey?: string;
  readonly fetchImpl?: FetchLike;
  /** Request timeout in milliseconds, on top of any long-poll wait. */
  readonly timeoutMs?: number;
}

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly body?: RequestBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth: boolean;
  readonly signal?: AbortSignal;
  readonly extraTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Sent on an HTTP post that is retrying a stream post whose ack never came, so
 * the two carry the same client id.
 */
export const IDEMPOTENCY_KEY_HEADER = "x-orsko-idempotency-key";

/** Carries a personal API key, which links the room to its owner's account. */
export const API_KEY_HEADER = "x-orsko-key";

function errorFrom(status: number, payload: unknown): OrskoApiError {
  const error = (
    payload as { error?: { code?: string; message?: string; retryAfterSeconds?: number } }
  )?.error;
  return new OrskoApiError(
    error?.code ?? "internal",
    error?.message ?? `request failed with status ${status}`,
    status,
    error?.retryAfterSeconds,
  );
}

export class OrskoClient {
  private readonly options: OrskoClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: OrskoClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get hasToken(): boolean {
    return typeof this.options.token === "string" && this.options.token.length > 0;
  }

  /** A copy of this client that authenticates with `token`. */
  withToken(token: string): OrskoClient {
    return new OrskoClient({ ...this.options, token });
  }

  private url(path: string): string {
    return `${this.options.baseUrl}/api/rooms/${this.options.roomId}${path}`;
  }

  private authHeader(): Record<string, string> {
    const token = this.options.token;
    if (!token) throw new Error("this call needs a member token; join the room first");
    return { authorization: `Bearer ${token}` };
  }

  private async request(options: RequestOptions): Promise<Response> {
    const timeoutMs =
      (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + (options.extraTimeoutMs ?? 0);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const headers = {
      accept: "application/json",
      ...(options.headers ?? {}),
      ...(options.auth ? this.authHeader() : {}),
    };
    const init: RequestInit = {
      method: options.method,
      headers,
      signal: AbortSignal.any(signals),
    };
    try {
      return await this.fetchImpl(this.url(options.path), {
        ...init,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new OrskoNetworkError(`request to ${options.method} ${options.path} failed`, {
        cause: error,
      });
    }
  }

  private async json<T>(options: RequestOptions): Promise<T> {
    const response = await this.request(options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw errorFrom(response.status, payload);
    return payload as T;
  }

  /** The `X-Orsko-Key` header, or nothing when no key is configured. */
  private apiKeyHeader(): Record<string, string> {
    const key = this.options.apiKey;
    return key ? { [API_KEY_HEADER]: key } : {};
  }

  /**
   * Joins the room. `invite` is the single-use token a private room requires;
   * a configured API key rides along as `X-Orsko-Key` so the room shows up in
   * that account's history.
   */
  join(input: {
    readonly name: string;
    readonly role?: string;
    readonly invite?: string;
  }): Promise<JoinResult> {
    return this.json<JoinResult>({
      method: "POST",
      path: "/members",
      auth: false,
      headers: { "content-type": "application/json", ...this.apiKeyHeader() },
      body: JSON.stringify(input),
    });
  }

  members(): Promise<MembersResult> {
    return this.json<MembersResult>({ method: "GET", path: "/members", auth: true });
  }

  poll(input: {
    readonly since: number;
    readonly waitSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<PollResult> {
    const query = `?since=${input.since}&waitSeconds=${input.waitSeconds}`;
    return this.json<PollResult>({
      method: "GET",
      path: `/messages${query}`,
      auth: true,
      extraTimeoutMs: input.waitSeconds * 1000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Posts a message. `idempotencyKey` is sent as `X-Orsko-Idempotency-Key` and
   * carries the client id of a stream post this call is retrying, so a server
   * that dedupes by it cannot store the same reply twice. Today's server
   * ignores the header; see the README.
   */
  post(input: {
    readonly text: string;
    readonly attachmentIds?: readonly string[];
    readonly idempotencyKey?: string;
  }): Promise<PostedMessage> {
    const { idempotencyKey, ...body } = input;
    return this.json<PostedMessage>({
      method: "POST",
      path: "/messages",
      auth: true,
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
      },
      body: JSON.stringify(body),
    });
  }

  /** Records the room's outcome; the latest write wins. Agents only. */
  setOutcome(text: string): Promise<{ readonly outcome: Outcome }> {
    return this.json<{ readonly outcome: Outcome }>({
      method: "PUT",
      path: "/outcome",
      auth: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  upload(input: {
    readonly filename: string;
    readonly contentType: string;
    readonly body: Uint8Array;
  }): Promise<AttachmentResult> {
    return this.json<AttachmentResult>({
      method: "PUT",
      path: "/attachments",
      auth: true,
      headers: {
        "x-filename": input.filename,
        "content-type": input.contentType,
        "content-length": String(input.body.byteLength),
      },
      body: input.body,
    });
  }

  async leave(): Promise<void> {
    const response = await this.request({ method: "POST", path: "/leave", auth: true });
    if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => null));
  }
}
