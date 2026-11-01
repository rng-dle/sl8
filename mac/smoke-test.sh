#!/usr/bin/env bash
# Starts the built app with sync off and a fixed token, then drives its local API with curl: canvases, items, catching up,
# deletes, search, files and ranges, static pages, and the rejection of requests without the cookie. macOS only.
set -uo pipefail
cd "$(dirname "$0")"
APP=build/ThinkSL8.app/Contents/MacOS/ThinkSL8
DIR="$HOME/Library/Application Support/ThinkSL8"
rm -rf "$DIR"; mkdir -p "$DIR"
sqlite3 "$DIR/sl8.sqlite" "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('sid','test-session'),('email','t@example.com');"
SL8_NO_SYNC=1 SL8_TEST_TOKEN=smoketoken "$APP" >/tmp/sl8-app.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
PORT=""
for i in $(seq 1 40); do
  for p in $(seq 47818 47838); do
    if curl -s -o /dev/null --max-time 1 -H "Host: 127.0.0.1:$p" "http://127.0.0.1:$p/__open?k=smoketoken"; then PORT=$p; break 2; fi
  done
  sleep 0.5
done
[ -n "$PORT" ] || { echo "app never listened"; cat /tmp/sl8-app.log; exit 1; }
B="http://127.0.0.1:$PORT"; C="Cookie: sl8k=smoketoken"
FAILS=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: wanted [$3] got [$2]"; FAILS=$((FAILS+1)); fi; }
has() { case "$2" in *"$3"*) echo "ok   $1";; *) echo "FAIL $1: [$2] lacks [$3]"; FAILS=$((FAILS+1));; esac; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
j() { curl -s --max-time 10 -H "$C" "$@"; }

ok "no cookie is refused" "$(code "$B/")" 403
ok "wrong host is refused" "$(code -H "$C" -H "Host: evil.example" "$B/")" 403
ok "index page" "$(code -H "$C" "$B/")" 200
ok "clean url /canvases" "$(code -H "$C" "$B/canvases")" 200
ok "note page" "$(code -H "$C" "$B/note")" 200
ok "unknown page is 404" "$(code -H "$C" "$B/nope")" 404
ok "config" "$(j "$B/api/config")" '{"botCheck":null}'

NID=$(j -X POST -H 'content-type: application/json' -d '{"title":"First"}' "$B/api/notes" | sed 's/.*"id":"\([^"]*\)".*/\1/')
has "create canvas" "$NID" "-"
has "list has it" "$(j "$B/api/notes")" "\"title\":\"First\""
NOW=$(( $(date +%s) * 1000 ))
j -X POST -H 'content-type: application/json' -d "{\"ops\":[{\"put\":{\"id\":\"a1\",\"kind\":\"text\",\"t\":$NOW,\"x\":1,\"y\":2,\"w\":3,\"s\":4,\"c\":\"#000\",\"text\":\"Hello Mellow\"}}]}" "$B/api/notes/$NID/ops" >/tmp/o.json
ok "save item" "$(cat /tmp/o.json)" '{"ok":true}'
has "open canvas has item" "$(j "$B/api/notes/$NID")" "Hello Mellow"
has "search finds text" "$(j "$B/api/search?q=mello")" "Hello"
ok "own save is not echoed back" "$(j "$B/api/notes/$NID?since=$((NOW-1000))" | grep -c Hello)" 0
j -X POST -H 'content-type: application/json' -d '{"ops":[{"del":"a1"}]}' "$B/api/notes/$NID/ops" >/dev/null
ok "item deleted" "$(j "$B/api/notes/$NID" | grep -c Hello)" 0
j -X PATCH -H 'content-type: application/json' -d '{"title":"Renamed"}' "$B/api/notes/$NID" >/dev/null
has "rename" "$(j "$B/api/notes")" "Renamed"
ok "bad op rejected" "$(code -H "$C" -X POST -H 'content-type: application/json' -d '{"ops":[{"x":1}]}' "$B/api/notes/$NID/ops")" 400
ok "unknown canvas" "$(code -H "$C" "$B/api/notes/nope")" 404

printf '\xff\xd8\xff\xe0JFIFxxxxxxxxxxxxxxxx' > /tmp/pic.jpg
FID=$(curl -s -H "$C" -X POST --data-binary @/tmp/pic.jpg -H 'content-type: image/jpeg' "$B/api/files" | sed 's/.*"id":"\([^"]*\)".*/\1/')
has "upload file" "$FID" "-"
ok "file served" "$(code -H "$C" "$B/api/files/$FID")" 200
ok "file range" "$(code -H "$C" -H 'Range: bytes=0-3' "$B/api/files/$FID")" 206
ok "junk upload refused" "$(code -H "$C" -X POST --data-binary 'hello' "$B/api/files")" 415

j -X DELETE "$B/api/notes/$NID" >/dev/null
ok "delete canvas" "$(j "$B/api/notes" | grep -c Renamed)" 0

if [ $FAILS -ne 0 ]; then echo "$FAILS failed"; cat /tmp/sl8-app.log; exit 1; fi
echo "all passed"
