// The bridge: mailboxes between a user's own AIs (Jet, Max, a teammate's assistant...) so they can hand work back and forth
// without the human relaying. Design goal: spend as few tokens as possible.
//  - Reads are cursor-based: an AI only ever receives what it hasn't seen, and an empty check costs ~60 bytes.
//  - The server tells the AI when to look again (next_check_minutes, or stand_down when no work is open), so idle AIs stop polling.
//  - Messages carry a kind and needs_reply, so "ok"/"done" closes a thread instead of triggering another model turn.
//  - Loop guards (duplicate bodies, thread length, daily cap) stop two AIs from burning usage on each other.
//  - bridge_stats shows each AI's checks, empty checks and characters moved, with a plain-language suggestion.
import { z } from 'zod';

const KINDS = ['task', 'question', 'answer', 'result', 'note', 'done'];
const NEEDS_REPLY = new Set(['task', 'question']);
const MAX_BODY = 8000;
const MAX_BATCH = 10;
const BATCH_BODY = 4000;
const THREAD_CAP = 40;     // messages in one thread before the AIs must ask the human
const DAILY_SEND_CAP = 300;
const DUPLICATE_WINDOW = 10 * 60 * 1000;
export const HANDLE = /^[a-z][a-z0-9_-]{1,23}$/;
export const cleanHandle = (s) => { const h = String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24); return HANDLE.test(h) ? h : ''; };

const out = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: m }] });
const day = () => new Date().toISOString().slice(0, 10);

// How long the AI should wait before looking again, from how recently this pair was active and whether any reply is owed.
export function nextCheck({ unread, openForMe, openForThem, idleMs }) {
  if (unread) return { next_check_minutes: 2 };
  if (openForMe) return { next_check_minutes: 2 };
  if (!openForThem) return { stand_down: true, next_check_minutes: 240, hint: 'No open work in either direction. Stop polling; check again only when the human asks, or on your next scheduled run.' };
  const m = idleMs < 10 * 60e3 ? 3 : idleMs < 60 * 60e3 ? 10 : idleMs < 6 * 3600e3 ? 30 : 120;
  return { next_check_minutes: m };
}

// wake(agent, text): ping the recipient (its inbox alerts: a Claude routine, a phone push, email). mirror(text): append to the
// owner's "Claude Bridge Log" canvas so humans can follow along; neither costs any AI tokens.
export function registerBridge(s, env, { userId, scopes = [], agent }, { wake = () => {}, mirror = () => {} } = {}) {
  const gate = () => {
    if (!scopes.includes('canvas:write')) return 'The bridge needs write access. Reconnect ThinkSL8 and tick "allow adding".';
    if (!agent) return 'This connection has no agent name. Reconnect ThinkSL8 and enter a name for this AI (for example jet or max).';
    return null;
  };
  const usage = ({ sends = 0, checks = 0, empty = 0, cin = 0, cout = 0 }) => env.DB.prepare(
    `INSERT INTO bridge_usage (user_id, agent, day, sends, checks, empty_checks, chars_in, chars_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, agent, day) DO UPDATE SET sends = sends + excluded.sends, checks = checks + excluded.checks, empty_checks = empty_checks + excluded.empty_checks,
       chars_in = chars_in + excluded.chars_in, chars_out = chars_out + excluded.chars_out`
  ).bind(userId, agent, day(), sends, checks, empty, cin, cout);

  // A message needs_reply and nothing newer in its thread came from the recipient: work is still owed.
  const open = async (who, dir) => {
    const col = dir === 'to' ? 'to_agent' : 'from_agent';
    return env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bridge_messages m WHERE m.user_id = ? AND m.${col} = ? AND m.needs_reply = 1
       AND NOT EXISTS (SELECT 1 FROM bridge_messages r WHERE r.user_id = m.user_id AND r.thread = m.thread AND r.id > m.id AND r.from_agent = m.to_agent)`
    ).bind(userId, who).first('n');
  };

  s.registerTool('bridge_send', {
    description: 'Send a message to other agents by name: another AI (e.g. "max") or a human ("josh" reaches Josh\'s phone). Several names separated by commas reach each of them. The recipient is woken automatically if its owner set that up, so never ask a human to relay. Use kind "task" or "question" when you need a reply, "result" or "answer" to respond, "done" to close a thread (no reply expected, so it costs the other side nothing). Keep bodies short; put long material on a canvas and pass its id as ref. Reuse "thread" to continue a conversation. Needs write access.',
    inputSchema: { to: z.string().min(2).max(130), body: z.string().min(1).max(MAX_BODY), kind: z.enum(KINDS).optional(), thread: z.string().min(1).max(64).optional(), ref: z.string().max(300).optional(), needs_reply: z.boolean().optional() },
  }, async ({ to, body, kind = 'note', thread, ref, needs_reply }) => {
    const g = gate(); if (g) return err(g);
    const targets = [...new Set(String(to).split(',').map(cleanHandle))];
    if (!targets.length || targets.length > 5 || targets.some((t) => !t || t === agent)) return err('Address the message to up to 5 other agents by name, separated by commas.');
    const t = thread || crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    const sent = await env.DB.prepare('SELECT COALESCE(sends, 0) AS n FROM bridge_usage WHERE user_id = ? AND agent = ? AND day = ?').bind(userId, agent, day()).first('n');
    if ((sent ?? 0) + targets.length > DAILY_SEND_CAP) return err(`Daily bridge cap (${DAILY_SEND_CAP} messages) reached. Ask the human before sending more.`);
    const { n: count, dup } = await env.DB.prepare(
      'SELECT COUNT(*) AS n, SUM(from_agent = ? AND body = ? AND created_at > ?) AS dup FROM bridge_messages WHERE user_id = ? AND thread = ?'
    ).bind(agent, body, now - DUPLICATE_WINDOW, userId, t).first();
    if (dup) return err('You already sent this exact message in this thread a moment ago. Wait for a reply instead of repeating it.');
    if (count + targets.length > THREAD_CAP) return err(`This thread has reached ${THREAD_CAP} messages. Stop and summarise for the human (to "josh"), or start a new thread with a short summary as the first message.`);
    const reply = needs_reply ?? NEEDS_REPLY.has(kind);
    const ids = [];
    for (const target of targets) {
      ids.push(await env.DB.prepare(
        'INSERT INTO bridge_messages (user_id, thread, from_agent, to_agent, kind, body, ref, needs_reply, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(userId, t, agent, target, kind, body, ref ?? null, reply ? 1 : 0, now).first('id'));
    }
    await usage({ sends: targets.length, cout: body.length * targets.length }).run();
    const head = `${agent} → ${targets.join(', ')} · ${kind}${reply ? ' (reply expected)' : ''} · thread ${t}`;
    for (const target of targets) wake(target, `${head}: ${body.split('\n')[0].slice(0, 160)}`);
    mirror(`## ${head}\n${body}${ref ? `\nRef: ${ref}` : ''}`);
    return out({ sent: ids.length === 1 ? ids[0] : ids, thread: t, to: targets, needs_reply: reply });
  });

  s.registerTool('bridge_agents', {
    description: 'Who is on the bridge: every agent name that has sent or received messages, when each was last active, and how many replies each still owes. Use it to pick who to delegate to; it is cheap.',
  }, async () => {
    const g = gate(); if (g) return err(g);
    const { results } = await env.DB.prepare(
      `SELECT a AS agent, MAX(t) AS last FROM (SELECT from_agent AS a, created_at AS t FROM bridge_messages WHERE user_id = ? UNION ALL SELECT to_agent, created_at FROM bridge_messages WHERE user_id = ?) GROUP BY a ORDER BY last DESC LIMIT 50`
    ).bind(userId, userId).all();
    const rows = await Promise.all(results.map(async (r) => ({ agent: r.agent, last_active: new Date(r.last).toISOString(), owes_replies: await open(r.agent, 'to'), ...(r.agent === agent && { you: true }) })));
    return out(rows.length ? rows : [{ agent, you: true, note: 'No messages yet. Send one with bridge_send.' }]);
  });

  s.registerTool('bridge_check', {
    description: 'Check your bridge inbox. Returns only messages you have not seen (oldest first, up to 10), marks them read, and tells you when to check again: obey next_check_minutes, and when it says stand_down, stop polling until your human asks. An empty check is tiny, so check rather than guess, but never check more often than the hint says.',
  }, async () => {
    const g = gate(); if (g) return err(g);
    const { results } = await env.DB.prepare(
      'SELECT id, thread, from_agent AS "from", kind, body, ref, needs_reply, created_at FROM bridge_messages WHERE user_id = ? AND to_agent = ? AND read_at IS NULL ORDER BY id LIMIT ?'
    ).bind(userId, agent, MAX_BATCH + 1).all();
    const batch = results.slice(0, MAX_BATCH);
    const more = results.length > MAX_BATCH;
    if (batch.length) await env.DB.prepare(`UPDATE bridge_messages SET read_at = ? WHERE user_id = ? AND id IN (${batch.map(() => '?').join(',')})`).bind(Date.now(), userId, ...batch.map((m) => m.id)).run();
    const chars = batch.reduce((n, m) => n + m.body.length, 0);
    await usage({ checks: 1, empty: batch.length ? 0 : 1, cin: chars }).run();
    const [openForMe, openForThem, last] = await Promise.all([
      open(agent, 'to'), open(agent, 'from'),
      env.DB.prepare('SELECT MAX(created_at) AS t FROM bridge_messages WHERE user_id = ? AND (to_agent = ? OR from_agent = ?)').bind(userId, agent, agent).first('t'),
    ]);
    const pace = nextCheck({ unread: more, openForMe, openForThem, idleMs: Date.now() - (last || 0) });
    if (!batch.length) return out({ unread: 0, ...pace });
    return out({
      unread: batch.length, more_waiting: more, ...pace,
      messages: batch.map((m) => ({ id: m.id, thread: m.thread, from: m.from, kind: m.kind, reply_expected: !!m.needs_reply, ...(m.ref && { ref: m.ref }), body: m.body.length > BATCH_BODY ? m.body.slice(0, BATCH_BODY) + ' …[cut: ask for the rest by thread]' : m.body })),
    });
  });

  s.registerTool('bridge_thread', {
    description: 'Read the latest messages of a thread (without marking anything read), newest last. Use it to catch up on a thread you are asked to continue, not as a routine check.',
    inputSchema: { thread: z.string().min(1).max(64), limit: z.number().int().min(1).max(20).optional() },
  }, async ({ thread, limit = 8 }) => {
    const g = gate(); if (g) return err(g);
    const { results } = await env.DB.prepare(
      'SELECT id, from_agent AS "from", to_agent AS "to", kind, body, ref, created_at FROM (SELECT * FROM bridge_messages WHERE user_id = ? AND thread = ? AND (to_agent = ? OR from_agent = ?) ORDER BY id DESC LIMIT ?) ORDER BY id'
    ).bind(userId, thread, agent, agent, limit).all();
    return out(results.map((m) => ({ ...m, at: new Date(m.created_at).toISOString(), created_at: undefined })));
  });

  s.registerTool('bridge_stats', {
    description: 'Your recent bridge usage (last 7 days): messages sent, checks, how many checks were empty, and characters moved, with a suggestion if you are polling more than the traffic justifies.',
  }, async () => {
    const g = gate(); if (g) return err(g);
    const { results } = await env.DB.prepare('SELECT day, sends, checks, empty_checks, chars_in, chars_out FROM bridge_usage WHERE user_id = ? AND agent = ? ORDER BY day DESC LIMIT 7').bind(userId, agent).all();
    const t = results.reduce((a, r) => ({ checks: a.checks + r.checks, empty: a.empty + r.empty_checks, sends: a.sends + r.sends }), { checks: 0, empty: 0, sends: 0 });
    const ratio = t.checks ? t.empty / t.checks : 0;
    const advice = t.checks >= 10 && ratio > 0.7 ? `${Math.round(ratio * 100)}% of your checks found nothing. Obey next_check_minutes and stand_down; if your schedule is fixed, lengthen it.` : 'Polling looks proportionate to the traffic.';
    return out({ agent, days: results, totals: t, empty_ratio: Math.round(ratio * 100) / 100, advice });
  });
}
