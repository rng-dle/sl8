#!/usr/bin/env bash
# Smoke test against a running server: `npx wrangler dev` then `bash smoke-test.sh [base-url]`
set -euo pipefail
B=${1:-http://127.0.0.1:8787}
J='content-type: application/json'
pass() { echo "ok  - $1"; }
die() { echo "FAIL - $1"; exit 1; }
sid() { grep -o 'sid=[a-f0-9]*' | head -1; }

A="smoke-a-$RANDOM@example.com"; C="smoke-b-$RANDOM@example.com"
CA=$(curl -s -D - -o /dev/null -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/signup | sid)
[ -n "$CA" ] && pass "signup sets session" || die "signup"
curl -s -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/signup | grep -q 'already has an account' && pass "duplicate email rejected" || die "duplicate"
curl -s -H "$J" -d '{"email":"bad","password":"x"}' $B/api/signup | grep -q 'valid email' && pass "bad email rejected" || die "validation"
curl -s -H "cookie: $CA" $B/api/me | grep -q "$A" && pass "me" || die "me"

NOTE=$(curl -s -H "cookie: $CA" -H "$J" -d '{"title":"Lecture 1"}' $B/api/notes | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
[ -n "$NOTE" ] && pass "create note" || die "create note"
OPS='{"ops":[{"put":{"id":"s1","kind":"stroke","t":1,"c":"ink","w":3,"pr":true,"p":[0,0,0.5,10,10,0.6]}},{"put":{"id":"x1","kind":"text","t":2,"x":5,"y":5,"w":320,"s":22,"c":"blue","text":"hello"}}]}'
curl -s -H "cookie: $CA" -H "$J" -d "$OPS" $B/api/notes/$NOTE/ops | grep -q '"ok":true' && pass "save items" || die "save items"
curl -s -H "cookie: $CA" -H "$J" -d '{"ops":[{"del":"s1"}]}' $B/api/notes/$NOTE/ops >/dev/null
GOT=$(curl -s -H "cookie: $CA" $B/api/notes/$NOTE)
echo "$GOT" | grep -q '"text":"hello"' && ! echo "$GOT" | grep -q '"s1"' && pass "load items after delete" || die "load: $GOT"
curl -s -H "cookie: $CA" -H "$J" -X PATCH -d '{"title":"Renamed"}' $B/api/notes/$NOTE | grep -q Renamed && pass "rename" || die "rename"
curl -s -H "cookie: $CA" -H "$J" -d '{"ops":[{"put":{"id":"bad id!","kind":"stroke","t":1}}]}' $B/api/notes/$NOTE/ops | grep -q malformed && pass "malformed op rejected" || die "malformed"
curl -s -H "cookie: $CA" -H "$J" -H 'origin: https://evil.example' -d '{}' $B/api/notes | grep -q 'wrong origin' && pass "cross-origin write blocked" || die "origin"

CB=$(curl -s -D - -o /dev/null -H "$J" -d "{\"email\":\"$C\",\"password\":\"hunter2hunter2\"}" $B/api/signup | sid)
curl -s -H "cookie: $CB" $B/api/notes/$NOTE | grep -q 'not found' && pass "other user cannot read" || die "isolation read"
curl -s -H "cookie: $CB" -H "$J" -d "$OPS" $B/api/notes/$NOTE/ops | grep -q 'not found' && pass "other user cannot write" || die "isolation write"
curl -s -H "cookie: $CB" $B/api/notes | grep -q '"notes":\[\]' && pass "other user sees empty list" || die "isolation list"

for i in $(seq 1 10); do curl -s -o /dev/null -H "$J" -d "{\"email\":\"$A\",\"password\":\"wrongwrong\"}" $B/api/login; done
curl -s -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/login | grep -q 'Too many' && pass "lockout after 10 failures" || die "lockout"

curl -s -H "cookie: $CA" -H "$J" -X POST -d '{}' $B/api/logout >/dev/null
curl -s -H "cookie: $CA" $B/api/me | grep -q 'Log in' && pass "logout ends session" || die "logout"
curl -s -H "cookie: $CB" -H "$J" -X DELETE $B/api/notes/$NOTE | grep -q 'not found' && pass "other user cannot delete" || die "isolation delete"
echo "all passed"
