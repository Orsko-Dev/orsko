import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_STREAM_CLIENT_ID_CHARS } from "../config/constants";
import { AttachmentIdParam } from "./schemas";

/**
 * The three frames a stream client may send. Everything else — an unknown
 * `type`, a malformed field — is answered with an `error` frame rather than
 * closing the socket, so a client bug costs one frame and not the session.
 */
export const HelloFrame = z.object({
  type: z.literal("hello"),
  token: z.string().min(1, "hello requires a token"),
  since: z.coerce.number().int().min(0).optional(),
});

export const PostFrame = z.object({
  type: z.literal("post"),
  id: z.string().min(1).max(MAX_STREAM_CLIENT_ID_CHARS),
  text: z.string().min(1),
  attachmentIds: z.array(AttachmentIdParam).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});

export const ReadFrame = z.object({
  type: z.literal("read"),
  since: z.coerce.number().int().min(0),
});

export const ClientFrame = z.discriminatedUnion("type", [HelloFrame, PostFrame, ReadFrame]);

export type HelloInput = z.infer<typeof HelloFrame>;
export type PostInput = z.infer<typeof PostFrame>;
export type ReadInput = z.infer<typeof ReadFrame>;
export type ClientFrameInput = z.infer<typeof ClientFrame>;

export type ParsedFrame =
  | { readonly kind: "frame"; readonly frame: ClientFrameInput }
  /** Not JSON at all: the socket is closed, since the client is not speaking the protocol. */
  | { readonly kind: "malformed"; readonly message: string }
  /** JSON, but not a frame we serve: answered with an `error` and the socket stays open. */
  | { readonly kind: "invalid"; readonly id: string | undefined; readonly message: string };

/** The client id of a frame that failed validation, so the error can be correlated. */
function clientIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_STREAM_CLIENT_ID_CHARS
    ? id
    : undefined;
}

export function parseClientFrame(raw: string): ParsedFrame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed", message: "frames must be JSON objects" };
  }
  const parsed = ClientFrame.safeParse(json);
  if (parsed.success) return { kind: "frame", frame: parsed.data };
  return {
    kind: "invalid",
    id: clientIdOf(json),
    message: parsed.error.issues[0]?.message ?? "invalid frame",
  };
}
