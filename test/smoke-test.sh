#!/usr/bin/env bash
# Smoke test against a running server: `npx wrangler dev` then `bash test/smoke-test.sh [base-url]`
set -euo pipefail
B=${1:-http://127.0.0.1:8787}
J='content-type: application/json'
IP="cf-connecting-ip: 10.$((RANDOM%250)).$((RANDOM%250)).$((RANDOM%250))" # this run's own address, so rate limits don't carry over
c() { command curl -s -H "$IP" "$@"; }
pass() { echo "ok  - $1"; }
die() { echo "FAIL - $1"; exit 1; }
sid() { grep -o 'sid=[a-f0-9]*' | head -1; }

A="smoke-a-$RANDOM@example.com"; C="smoke-b-$RANDOM@example.com"
CA=$(c -D - -o /dev/null -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/signup | sid)
[ -n "$CA" ] && pass "signup sets session" || die "signup"
c -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/signup | grep -q 'already has an account' && pass "duplicate email rejected" || die "duplicate"
c -H "$J" -d '{"email":"bad","password":"x"}' $B/api/signup | grep -q 'valid email' && pass "bad email rejected" || die "validation"
c -H "cookie: $CA" $B/api/me | grep -q "$A" && pass "me" || die "me"

NOTE=$(c -H "cookie: $CA" -H "$J" -d '{"title":"Lecture 1"}' $B/api/notes | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
[ -n "$NOTE" ] && pass "create note" || die "create note"
OPS='{"ops":[{"put":{"id":"s1","kind":"stroke","t":1,"c":"ink","w":3,"pr":true,"p":[0,0,0.5,10,10,0.6]}},{"put":{"id":"x1","kind":"text","t":2,"x":5,"y":5,"w":320,"s":22,"c":"blue","text":"hello"}}]}'
c -H "cookie: $CA" -H "$J" -d "$OPS" $B/api/notes/$NOTE/ops | grep -q '"ok":true' && pass "save items" || die "save items"
c -H "cookie: $CA" -H "$J" -d '{"ops":[{"del":"s1"}]}' $B/api/notes/$NOTE/ops >/dev/null
GOT=$(c -H "cookie: $CA" $B/api/notes/$NOTE)
echo "$GOT" | grep -q '"text":"hello"' && ! echo "$GOT" | grep -q '"s1"' && pass "load items after delete" || die "load: $GOT"
c -H "cookie: $CA" -H "$J" -X PATCH -d '{"title":"Renamed"}' $B/api/notes/$NOTE | grep -q Renamed && pass "rename" || die "rename"
c -H "cookie: $CA" -H "$J" -d '{"ops":[{"put":{"id":"bad id!","kind":"stroke","t":1}}]}' $B/api/notes/$NOTE/ops | grep -q malformed && pass "malformed op rejected" || die "malformed"
c -H "cookie: $CA" -H "$J" -H 'origin: https://evil.example' -d '{}' $B/api/notes | grep -q 'wrong origin' && pass "cross-origin write blocked" || die "origin"

CB=$(c -D - -o /dev/null -H "$J" -d "{\"email\":\"$C\",\"password\":\"hunter2hunter2\"}" $B/api/signup | sid)
c -H "cookie: $CB" $B/api/notes/$NOTE | grep -q 'not found' && pass "other user cannot read" || die "isolation read"
c -H "cookie: $CB" -H "$J" -d "$OPS" $B/api/notes/$NOTE/ops | grep -q 'not found' && pass "other user cannot write" || die "isolation write"
c -H "cookie: $CB" $B/api/notes | grep -q '"notes":\[\]' && pass "other user sees empty list" || die "isolation list"

for i in $(seq 1 10); do c -o /dev/null -H "$J" -d "{\"email\":\"$A\",\"password\":\"wrongwrong\"}" $B/api/login; done
c -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/login | grep -q 'Too many' && pass "lockout after 10 failures" || die "lockout"
command curl -s -H "cf-connecting-ip: 10.251.$((RANDOM%250)).$((RANDOM%250))" -H "$J" -d "{\"email\":\"$A\",\"password\":\"hunter2hunter2\"}" $B/api/login | grep -q "$A" && pass "the owner on another network can still sign in" || die "lockout is per network"

c -H "cookie: $CA" -H "$J" -X POST -d '{}' $B/api/logout >/dev/null
c -H "cookie: $CA" $B/api/me | grep -q 'Log in' && pass "logout ends session" || die "logout"
c -H "cookie: $CB" -H "$J" -X DELETE $B/api/notes/$NOTE | grep -q 'not found' && pass "other user cannot delete" || die "isolation delete"
echo "all passed"
