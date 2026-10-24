#!/usr/bin/env bash
# Two curl "agents" collaborate in a room on a deployed Orsko instance.
# Usage: scripts/e2e.sh https://orsko.example
set -euo pipefail
BASE="${1:?base url required}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
# The value of one string field in a JSON response whose field appears once.
field() { echo "$1" | sed -E "s/.*\"$2\":\"([^\"]+)\".*/\1/"; }

ROOM=$(curl -sf -X POST "$BASE/api/rooms" -H 'content-type: application/json' -d '{"purpose":"e2e"}')
ROOM_ID=$(field "$ROOM" roomId)
API="$BASE/api/rooms/$ROOM_ID"
echo "room: $BASE/r/$ROOM_ID"

join() { curl -sf -X POST "$API/members" -H 'content-type: application/json' -d "{\"name\":\"$1\"}"; }
ALICE_JOIN=$(join alice)
ALICE=$(field "$ALICE_JOIN" token)
ALICE_ID=$(field "$ALICE_JOIN" memberId)
BOB=$(field "$(join bob)" token)

post() { curl -sf -X POST "$API/messages" -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"text\":\"$2\"}"; }
poll() { curl -sf "$API/messages?since=$2&waitSeconds=$3" -H "authorization: Bearer $1"; }

# Establish bob's starting cursor with a non-waiting read first: since=0 would
# return immediately with the pre-existing system join messages, so a
# subsequent since=0 long-poll would also return immediately and never
# actually exercise the wake path.
BOB_INITIAL=$(poll "$BOB" 0 0)
NEXT_SINCE=$(echo "$BOB_INITIAL" | sed -E 's/.*"nextSince":([0-9]+).*/\1/')

# bob long-polls from that cursor, alice posts; bob must wake with alice's
# message, and must wake promptly rather than only via the waitSeconds timeout.
WAKE_START=$SECONDS
( poll "$BOB" "$NEXT_SINCE" 20 > "$TMP_DIR/bob.json" ) &
BOB_PID=$!
sleep 1
post "$ALICE" "hello from alice" >/dev/null
wait "$BOB_PID"
WAKE_ELAPSED=$((SECONDS - WAKE_START))

if [ "$WAKE_ELAPSED" -gt 15 ]; then
  fail "bob's long-poll took ${WAKE_ELAPSED}s (>15s), did not wake promptly"
fi
if ! grep -q "hello from alice" "$TMP_DIR/bob.json"; then
  fail "bob's long-poll response did not contain alice's message"
fi
echo "bob woke: ok"

post "$BOB" "hello from bob" >/dev/null

# alice has not been handed bob's message, so her next post must count it.
UNREAD_POST=$(post "$ALICE" "alice again")
if ! echo "$UNREAD_POST" | grep -qE '"unread":1[,}]'; then
  fail "alice's post did not report bob's message as unread: $UNREAD_POST"
fi
poll "$ALICE" 0 0 >/dev/null
READ_POST=$(post "$ALICE" "alice caught up")
if ! echo "$READ_POST" | grep -qE '"unread":0[,}]'; then
  fail "alice's post after reading still reported unread messages: $READ_POST"
fi
echo "unread: ok"

# An empty body names itself instead of failing as a schema error.
EMPTY_STATUS=$(curl -s -o "$TMP_DIR/empty.json" -w '%{http_code}' -X POST "$API/messages" \
  -H "authorization: Bearer $ALICE" -H 'content-type: application/json')
if [ "$EMPTY_STATUS" != "400" ]; then
  fail "an empty post body answered $EMPTY_STATUS, expected 400"
fi
if ! grep -q "request body is empty" "$TMP_DIR/empty.json"; then
  fail "an empty post body did not say so: $(cat "$TMP_DIR/empty.json")"
fi
echo "empty body: ok"

# The transcript of a live room requires a member token; only archived rooms
# serve it token-free.
if curl -sf "$API/transcript" >/dev/null 2>&1; then
  fail "live transcript was served without a token"
fi
ALL=$(curl -sf "$API/transcript" -H "authorization: Bearer $ALICE")
if ! echo "$ALL" | grep -q "hello from bob"; then
  fail "transcript did not contain bob's message"
fi
echo "transcript: ok"

# attachment round-trip: alice uploads a small text file, we download it back
# and verify the bytes match.
echo "attachment round-trip payload $(date +%s)" > "$TMP_DIR/upload.txt"
UPLOAD_SIZE=$(wc -c < "$TMP_DIR/upload.txt" | tr -d ' ')
UPLOAD=$(curl -sf -X PUT "$API/attachments" \
  -H "authorization: Bearer $ALICE" \
  -H 'x-filename: upload.txt' \
  -H 'content-type: text/plain' \
  -H "content-length: $UPLOAD_SIZE" \
  --data-binary "@$TMP_DIR/upload.txt")
ATTACHMENT_ID=$(field "$UPLOAD" attachmentId)

curl -sf "$API/attachments/$ATTACHMENT_ID" \
  -H "authorization: Bearer $BOB" \
  -o "$TMP_DIR/download.txt"

if ! cmp -s "$TMP_DIR/upload.txt" "$TMP_DIR/download.txt"; then
  fail "attachment download does not match upload (byte mismatch)"
fi
echo "attachment: ok"

# The outcome, sent from a file exactly as agents.md recommends (the
# apostrophe would break an inline single-quoted body).
cat > "$TMP_DIR/outcome.json" <<'EOF'
{"text":"e2e: it's decided, ship it"}
EOF
OUTCOME=$(curl -sf -X PUT "$API/outcome" -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' --data-binary "@$TMP_DIR/outcome.json")
if ! echo "$OUTCOME" | grep -q '"by":"alice"'; then
  fail "PUT /outcome did not record alice as its author: $OUTCOME"
fi
if ! curl -sf "$API" | grep -q "it's decided, ship it"; then
  fail "the room details do not carry the recorded outcome"
fi
echo "outcome: ok"

EXPORT_ANON=$(curl -s -o /dev/null -w '%{http_code}' "$API/transcript.md")
if [ "$EXPORT_ANON" != "401" ]; then
  fail "a live room's markdown export answered $EXPORT_ANON without a token, expected 401"
fi
curl -sf "$API/transcript.md" -H "authorization: Bearer $ALICE" -o "$TMP_DIR/transcript.md"
if ! grep -q "^# Orsko room $ROOM_ID" "$TMP_DIR/transcript.md"; then
  fail "the markdown export does not start with the room title"
fi
if ! grep -q "it's decided, ship it" "$TMP_DIR/transcript.md"; then
  fail "the markdown export does not carry the outcome"
fi
if ! grep -q "hello from bob" "$TMP_DIR/transcript.md"; then
  fail "the markdown export does not carry bob's message"
fi
echo "export: ok"

NOT_FOUND=$(curl -s -o "$TMP_DIR/not-found.json" -w '%{http_code}' "$API/nope")
if [ "$NOT_FOUND" != "404" ]; then
  fail "an unknown endpoint answered $NOT_FOUND, expected 404"
fi
if ! grep -q '"code":"not_found"' "$TMP_DIR/not-found.json"; then
  fail "an unknown endpoint did not answer not_found: $(cat "$TMP_DIR/not-found.json")"
fi
echo "not_found: ok"

BOB_LEAVE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/members/me" \
  -H "authorization: Bearer $BOB")
if [ "$BOB_LEAVE" != "204" ]; then
  fail "DELETE /members/me answered $BOB_LEAVE, expected 204"
fi
BOB_AFTER=$(curl -s -o /dev/null -w '%{http_code}' "$API/members" -H "authorization: Bearer $BOB")
if [ "$BOB_AFTER" != "401" ]; then
  fail "bob's token still worked after he left (answered $BOB_AFTER)"
fi
ALICE_LEAVE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/members/$ALICE_ID" \
  -H "authorization: Bearer $ALICE")
if [ "$ALICE_LEAVE" != "204" ]; then
  fail "DELETE /members/<own id> answered $ALICE_LEAVE, expected 204"
fi
echo "leave by DELETE: ok"

# The "any assistant" release: the ?format= override, the server-rendered
# room page, /connect and the stateless remote MCP connector at POST /mcp.
# A fresh public room, since the format override and the connector tools
# need one no earlier check has already mutated.
FORMAT_ROOM=$(curl -sf -X POST "$BASE/api/rooms" -H 'content-type: application/json' \
  -d '{"purpose":"e2e any assistant"}')
FORMAT_ID=$(field "$FORMAT_ROOM" roomId)
FORMAT_API="$BASE/api/rooms/$FORMAT_ID"

curl -sf "$BASE/r/$FORMAT_ID?format=md" -H 'accept: text/html' -o "$TMP_DIR/format.md"
if ! grep -q "^# Orsko room $FORMAT_ID" "$TMP_DIR/format.md"; then
  fail "?format=md under Accept: text/html did not return the room's markdown instructions"
fi
echo "format=md: ok"

# The room page's HTML, filled in server-side before any script runs: the
# paste sentence, the instructions and the join endpoint they name, and the
# relay seat. PUBLIC_BASE_URL can differ from $BASE, so this checks only the
# sentence text, never the host it is built with.
curl -sf "$BASE/r/$FORMAT_ID" -H 'accept: text/html' -o "$TMP_DIR/room.html"
if ! grep -q 'id="agent-instructions"' "$TMP_DIR/room.html"; then
  fail "room page is missing #agent-instructions"
fi
if ! grep -q "/api/rooms/$FORMAT_ID/members" "$TMP_DIR/room.html"; then
  fail "room page instructions do not name the room's members endpoint"
fi
if ! grep -q "Join the Orsko room at " "$TMP_DIR/room.html"; then
  fail "room page is missing the paste sentence"
fi
if ! grep -q 'id="relay"' "$TMP_DIR/room.html"; then
  fail "room page is missing the relay seat"
fi
echo "room page instructions: ok"

# /connect names the connector endpoint in #connector-url. It is filled from
# PUBLIC_BASE_URL, which can differ from $BASE (a local run still points at
# the production host), so this checks only that the filled value has a
# scheme, a host and a /mcp path, not that it equals $BASE/mcp. Scoping to
# the #connector-url element (rather than grepping "/mcp" anywhere on the
# page) also rejects the unfilled "…" placeholder and any incidental "/mcp"
# elsewhere on the page (for example ".cursor/mcp.json" in the Cursor config
# snippet).
CONNECT_STATUS=$(curl -s -o "$TMP_DIR/connect.html" -w '%{http_code}' "$BASE/connect")
if [ "$CONNECT_STATUS" != "200" ]; then
  fail "/connect answered $CONNECT_STATUS, expected 200"
fi
CONNECTOR_URL=$(python3 -c '
import re, sys
with open(sys.argv[1]) as f:
    html = f.read()
match = re.search(r"<pre id=\"connector-url\">(.*?)</pre>", html, re.DOTALL)
print(match.group(1).strip() if match else "")
' "$TMP_DIR/connect.html")
if ! echo "$CONNECTOR_URL" | grep -qE '^https?://[^/[:space:]]+/mcp$'; then
  fail "/connect's #connector-url is not a scheme, host and /mcp path: $CONNECTOR_URL"
fi
echo "connect page: ok"

# The connector never advertises OAuth: the well-known discovery paths fall
# through to the ordinary JSON 404, not a 401 or a WWW-Authenticate header.
OAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "$BASE/.well-known/oauth-protected-resource")
if [ "$OAUTH_STATUS" != "404" ]; then
  fail "oauth discovery answered $OAUTH_STATUS, expected 404"
fi
echo "oauth discovery 404: ok"

# The MCP connector, driven over JSON-RPC with curl. Every request is a file
# under $TMP_DIR (never inline -d) so a token never appears in a shell
# history or process list, and every response is saved to a file so a FAIL
# message never has to echo one back.
mcp_call() {
  curl -sf -X POST "$BASE/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data-binary "@$1"
}

cat > "$TMP_DIR/initialize.json" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"orsko-e2e","version":"1.0.0"}}}
EOF
mcp_call "$TMP_DIR/initialize.json" > "$TMP_DIR/initialize.out"
if ! grep -q '"name":"orsko"' "$TMP_DIR/initialize.out"; then
  fail "connector initialize did not report itself as orsko"
fi
echo "connector initialize: ok"

cat > "$TMP_DIR/tools-list.json" <<'EOF'
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
mcp_call "$TMP_DIR/tools-list.json" > "$TMP_DIR/tools-list.out"
for TOOL in orsko_join orsko_read orsko_post orsko_members orsko_leave \
  orsko_outcome orsko_share_text orsko_open_attachment; do
  if ! grep -q "\"name\":\"$TOOL\"" "$TMP_DIR/tools-list.out"; then
    fail "connector tools/list is missing $TOOL"
  fi
done
echo "connector tools/list: ok"

# carol is a plain HTTP member of the same room, so the connector member
# (joined below) has someone else's message waiting when it posts.
CAROL_JOIN=$(curl -sf -X POST "$FORMAT_API/members" -H 'content-type: application/json' \
  -d '{"name":"carol"}')
CAROL_TOKEN=$(field "$CAROL_JOIN" token)
echo "carol joins over HTTP: ok"

cat > "$TMP_DIR/join.json" <<EOF
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"orsko_join","arguments":{"room":"$BASE/r/$FORMAT_ID","name":"e2e-connector"}}}
EOF
mcp_call "$TMP_DIR/join.json" > "$TMP_DIR/join.out"
if grep -q '"isError":true' "$TMP_DIR/join.out"; then
  fail "orsko_join reported an error"
fi
# The token sits only in join.out on disk; field() on the raw JSON-RPC text
# would try to match the outer envelope, so the nested result is pulled with
# python3 instead of a fragile sed pattern.
CONNECTOR_TOKEN=$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get("result", {}).get("structuredContent", {}).get("token", ""))
' "$TMP_DIR/join.out")
if [ -z "$CONNECTOR_TOKEN" ]; then
  fail "orsko_join did not return a member token"
fi
echo "connector join: ok"

# carol posts over HTTP so the connector member's next post reports it unread.
curl -sf -X POST "$FORMAT_API/messages" -H "authorization: Bearer $CAROL_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"carol to the connector"}' >/dev/null

cat > "$TMP_DIR/post.json" <<EOF
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"orsko_post","arguments":{"room":"$FORMAT_ID","token":"$CONNECTOR_TOKEN","text":"hello from the connector"}}}
EOF
mcp_call "$TMP_DIR/post.json" > "$TMP_DIR/post.out"
# post.out carries no token, so it is safe to include in a FAIL message.
if ! grep -qE '"unread":[1-9]' "$TMP_DIR/post.out"; then
  fail "connector post did not report carol's message as unread: $(cat "$TMP_DIR/post.out")"
fi
echo "connector post with unread: ok"

cat > "$TMP_DIR/leave.json" <<EOF
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"orsko_leave","arguments":{"room":"$FORMAT_ID","token":"$CONNECTOR_TOKEN"}}}
EOF
mcp_call "$TMP_DIR/leave.json" > "$TMP_DIR/leave.out"
if ! grep -q '"left":true' "$TMP_DIR/leave.out"; then
  fail "orsko_leave did not report leaving"
fi
curl -sf -X POST "$FORMAT_API/leave" -H "authorization: Bearer $CAROL_TOKEN" >/dev/null
echo "connector leave: ok"

# The connector's token is spent: a later orsko_read with it must come back
# as a tool error, never a JSON-RPC error and never a thrown exception.
cat > "$TMP_DIR/read-after-leave.json" <<EOF
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"orsko_read","arguments":{"room":"$FORMAT_ID","token":"$CONNECTOR_TOKEN","since":0,"waitSeconds":0}}}
EOF
mcp_call "$TMP_DIR/read-after-leave.json" > "$TMP_DIR/read-after-leave.out"
if ! grep -q '"isError":true' "$TMP_DIR/read-after-leave.out"; then
  fail "orsko_read with a spent connector token did not report isError"
fi
echo "connector read after leave: ok"

# Stateless mode has no stream to open: every non-POST method on /mcp,
# starting with GET, is refused with 405 rather than treated as a session.
MCP_GET_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/mcp")
if [ "$MCP_GET_STATUS" != "405" ]; then
  fail "GET /mcp answered $MCP_GET_STATUS, expected 405"
fi
echo "mcp GET 405: ok"

# Private rooms need an account, and signing in cannot be scripted: set
# ORSKO_E2E_KEY to a personal API key (created at $BASE/me/keys) to run this
# part. Without it the public path above is the whole check.
if [ -z "${ORSKO_E2E_KEY:-}" ]; then
  echo "private room: skipped (set ORSKO_E2E_KEY to a personal API key to run it)"
  echo "e2e passed"
  exit 0
fi

PRIVATE=$(curl -sf -X POST "$BASE/api/rooms" \
  -H 'content-type: application/json' \
  -H "x-orsko-key: $ORSKO_E2E_KEY" \
  -d '{"purpose":"e2e private","private":true}')
PRIVATE_ID=$(field "$PRIVATE" roomId)
if ! echo "$PRIVATE" | grep -q '"private":true'; then
  fail "room created with private:true did not come back private"
fi
echo "private room: $BASE/r/$PRIVATE_ID"

# A join with no invite must be refused, before any invite is minted.
UNINVITED_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rooms/$PRIVATE_ID/members" \
  -H 'content-type: application/json' -d '{"name":"intruder"}')
if [ "$UNINVITED_STATUS" != "403" ]; then
  fail "join without an invite answered $UNINVITED_STATUS, expected 403"
fi
echo "private join refused without an invite: ok"

INVITE=$(curl -sf -X POST "$BASE/api/rooms/$PRIVATE_ID/invites" \
  -H 'content-type: application/json' \
  -H "x-orsko-key: $ORSKO_E2E_KEY" \
  -d '{"label":"e2e"}')
INVITE_TOKEN=$(field "$INVITE" token)

CAROL=$(field "$(curl -sf -X POST "$BASE/api/rooms/$PRIVATE_ID/members" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"carol\",\"invite\":\"$INVITE_TOKEN\"}")" token)
if [ -z "$CAROL" ]; then
  fail "join with an invite did not return a member token"
fi
echo "private join with an invite: ok"

# The invite is single-use: the same token must not admit a second agent.
REUSE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rooms/$PRIVATE_ID/members" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"dave\",\"invite\":\"$INVITE_TOKEN\"}")
if [ "$REUSE_STATUS" != "403" ]; then
  fail "reusing a spent invite answered $REUSE_STATUS, expected 403"
fi
echo "private invite is single-use: ok"

curl -sf -X POST "$BASE/api/rooms/$PRIVATE_ID/leave" -H "authorization: Bearer $CAROL" >/dev/null
echo "e2e passed"
