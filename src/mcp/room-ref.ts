import { RoomIdParam } from "../validation/schemas";

/**
 * Ported from `channel/src/config.ts`'s `parseRoomLocation`, keeping only the
 * room id: the connector never needs the link's origin, so a link on any
 * host, a `/r/<id>` path, a bare `r/<id>`, or a raw 12-character id all
 * resolve the same way. Returns null when nothing that looks like a room id
 * can be recovered.
 */
export function parseRoomReference(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withoutTail = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const match = /(?:^|\/)r\/([^/]+)$/.exec(withoutTail);
  const roomId = match?.[1] ?? withoutTail;
  return RoomIdParam.safeParse(roomId).success ? roomId : null;
}
