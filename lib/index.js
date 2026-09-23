/**
 * dsh-notify host half (plain ESM, ASCII only).
 *
 * Event-driven conversation notifications for DSH:
 *   - turn/start -> turn/end        -> notification labelled with the actual
 *     `TurnEndReason` (完成 / 已中止 / 被拦截 / 达到 Token 上限 / 被中断 /
 *     出错) plus elapsed time
 *   - turn/end reason 'error'       -> "error" sound
 *   - turn/end during an armed active goal -> SKIPPED (the round driver starts
 *     the next round immediately; see isAutoContinuing, ported from
 *     dsh-windows-notify)
 *   - agent/error                   -> "error" notification (non-turn failures)
 *   - goal/changed(complete)        -> "goal done" notification; the notice is
 *     paired with the turn it lands in, so that turn's `turn/end` does not
 *     also fire a "done" toast for the same moment
 *   - ask_user_question / approval  -> "ask" notification (immediate)
 * Subagent sessions are skipped. The skip key is the SESSION HEADER
 * (`session.header.origin === 'subagent'`, or a non-zero `delegationDepth`);
 * the event envelope itself carries no `origin` field.
 * Completion comes off the session event stream: DSH 0.1.5-rc.1 appends
 * `turn/start` / `turn/end` to the session log, and `turn/end` carries a
 * discriminated `TurnEndReason` ({ kind: 'completed' | 'aborted' | 'blocked' |
 * 'error' | 'max-tokens' | 'interrupted' }). The previous agent-phase polling
 * (which read the TypeScript-private `agent.phase` field and could only see
 * running/idle) is gone, along with the `agents` / `timer` service deps.
 *
 * Two classes of notice:
 *   - ATTENTION class = "the agent is stuck and needs you": ask_user_question,
 *     approval/asked, and a turn that ended with reason 'error' or 'blocked'.
 *     A failed turn (API quota, provider capacity, a rejected request) stops
 *     the agent and nothing happens until the user acts, so these ignore BOTH
 *     the soft mute and the foreground rule. Reporting one late is the same as
 *     not reporting it at all.
 *   - COMPLETION class = everything else, subject to `foregroundMode` and the
 *     soft mute.
 *   `muteAll` (file only) is the hard mute and silences both classes.
 *
 * Foreground handling for COMPLETION-class notices, by `foregroundMode`:
 *   - 'suppress' (default) - skipped while the app is in the foreground (web
 *     page visible OR any desktop-shell window focused); they fire only when
 *     the user is away.
 *   - 'always'             - fire in the foreground too.
 *   - 'long'               - fire in the foreground only for turns that ran at
 *     least `foregroundMinMs` (default 30s), so short chat turns stay quiet.
 *   Foreground state is reported in-memory (not persisted) by two channels:
 *     POST /dsh-notify/foreground { page: bool }   <- the web page (visibility
 *                                                      / window focus events)
 *     POST /dsh-notify/foreground { shell: bool }  <- the desktop shell (any
 *                                                      of its windows focused)
 *   Either channel reporting foreground wins (page OR shell). The initial
 *   state is background (notifications fire) so a broken reporting link can
 *   never silently swallow notifications.
 *
 * Dedupe: one notice per (id, kind) per 5 seconds, so a burst on one session
 * cannot spam - but notices of DIFFERENT kinds never silence each other. In
 * particular a question and a permission request on the same session are
 * separate kinds: collapsing them used to swallow whichever came second, and a
 * swallowed approval leaves the agent blocked with nothing on screen to say
 * so. `turn/end` and `agent/error` deliberately share the 'turn' kind, so one
 * failed turn still yields exactly one toast.
 *
 * Config lives in ~/.dsh/dsh-notify.json and is hot-reloaded per notification,
 * so edits apply without a restart. Two mute levels:
 *   - `notifications` (the header bell) is a SOFT mute: it silences
 *     completion-class notices only; attention-class still fires.
 *   - `muteAll` (file only) is a HARD mute: it silences everything.
 * The bell in the conversation header reads/writes the same config through
 * GET/POST /dsh-notify/config.
 *
 * Testability: the pure decision/argument logic (decideNotify,
 * foregroundAllowed, isAttentionReason, notifyKey, buildNotifyArgs, loadConfig,
 * saveConfig, isSameOrigin, titleOf, formatElapsed, systemLang, tr, trReason,
 * isSubagentSession, turnDetail, isAutoContinuing) is exported; the powershell
 * spawn is injectable via __setSpawnForTests and state resets via
 * __resetForTests.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-notify';

const DEFAULTS = {
  sound: true,
  toast: true,
  volume: 1.0,
  serviceNotify: true,
  notifications: true,
  // Foreground handling for completion-class notices (done / error / goal):
  //   'suppress' (default) - stay silent while the app is in the foreground
  //   'always'             - also fire in the foreground
  //   'long'               - fire in the foreground only for turns that ran at
  //                          least `foregroundMinMs`, so short chat turns stay
  //                          quiet while a long unattended task still lands
  // ask/approval notices are never subject to this.
  foregroundMode: 'suppress',
  foregroundMinMs: 30000,
  // Hard mute: silences EVERYTHING, ask/approval included. File-only escape
  // hatch; the header bell drives the soft mute (`notifications`) instead.
  muteAll: false,
};
const NOTIFY_SCRIPT = fileURLToPath(new URL('./notify.ps1', import.meta.url));
const CONFIG_ROUTE = '/dsh-notify/config';
const FOREGROUND_ROUTE = '/dsh-notify/foreground';
const DEDUPE_MS = 5000;

// --- foreground state (in-memory, dual-channel) --------------
let pageActive = false;
let shellActive = false;
function foreground() { return pageActive || shellActive; }

// --- system language (Windows) -------------------------------
let langCache = null;
export function systemLang() {
  if (langCache) return langCache;
  if (process.env.DSH_NOTIFY_LANG === 'zh' || process.env.DSH_NOTIFY_LANG === 'en') {
    langCache = process.env.DSH_NOTIFY_LANG;
    return langCache;
  }
  try {
    const r = spawnSync('reg.exe', ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = r.stdout.toString();
    const m = out.match(/LocaleName\s+REG_SZ\s+(\S+)/);
    langCache = m && m[1].toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    langCache = 'zh';
  }
  return langCache;
}
const T = {
  zh: {
    conv: '对话', done: '完成', failed: '出错', goal: '目标完成', ask: '需要你选择', approve: '需要你批准',
    reasons: {
      completed: '完成',
      aborted: '已中止',
      blocked: '被拦截',
      error: '出错',
      'max-tokens': '达到 Token 上限',
      interrupted: '被中断',
    },
  },
  en: {
    conv: 'Conversation', done: 'Done', failed: 'Failed', goal: 'Goal completed', ask: 'Your input needed', approve: 'Approval needed',
    reasons: {
      completed: 'completed',
      aborted: 'aborted',
      blocked: 'blocked',
      error: 'error',
      'max-tokens': 'max tokens reached',
      interrupted: 'interrupted',
    },
  },
};
export function tr(key) { return T[systemLang()][key]; }

/**
 * Localized label for a `TurnEndReason.kind`. A kind this build does not know
 * passes through verbatim (better an English word than a wrong "completed").
 * @param kind - the `TurnEndReason.kind` that closed the turn.
 * @returns the label to show in the toast.
 */
export function trReason(kind) {
  const reasons = T[systemLang()].reasons;
  if (typeof kind === 'string' && kind !== '' && reasons[kind] !== undefined) return reasons[kind];
  if (typeof kind === 'string' && kind !== '') return kind;
  return reasons.completed;
}

function resolveHome() {
  const envHome = process.env.DSH_HOME;
  return typeof envHome === 'string' && envHome.trim() !== ''
    ? envHome
    : join(homedir(), '.dsh');
}
function configPath() { return join(resolveHome(), 'dsh-notify.json'); }

export function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    // Windows editors happily prepend a UTF-8 BOM; JSON.parse rejects it, and
    // the catch below would then silently revert EVERY setting to its default.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return { ...DEFAULTS, ...JSON.parse(text) };
  } catch { return { ...DEFAULTS }; }
}
export function saveConfig(cfg) {
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    const tmp = configPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, configPath());
  } catch { /* best effort */ }
}

export function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (systemLang() === 'en') {
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 > 0 ? `${m}m ${s % 60}s` : `${m}min`;
    const h = Math.floor(m / 60);
    return m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
  }
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 > 0 ? `${m}分${s % 60}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h}小时${m % 60}分` : `${h}小时`;
}

/** Latest session/title event from the session's own event log. */
export function titleOf(session) {
  // DSH 0.1.5-rc.1 exposes the log through `snapshotEvents()`; there is no
  // `session.events` property. Keep the plain-array form as a fallback so
  // callers holding a detached event list still work.
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events;
  if (!Array.isArray(events)) return undefined;
  const ev = [...events].reverse().find((e) => e.type === 'session/title');
  const title = ev?.data?.title;
  if (typeof title !== 'string' || title.trim() === '') return undefined;
  return title.trim().slice(0, 20); // keep the toast one-line and tidy
}

/**
 * Whether a completion-class notice may interrupt the foreground.
 * @param cfg - the effective config.
 * @param elapsedMs - the turn's duration in ms when known, else undefined.
 * @returns true when the notice is allowed through in the foreground.
 */
export function foregroundAllowed(cfg, elapsedMs) {
  const mode = cfg?.foregroundMode;
  if (mode === 'always') return true;
  if (mode === 'long') {
    const min = typeof cfg?.foregroundMinMs === 'number' ? cfg.foregroundMinMs : DEFAULTS.foregroundMinMs;
    return typeof elapsedMs === 'number' && elapsedMs >= min;
  }
  return false; // 'suppress' (the default) and any unrecognized value
}

/**
 * Whether a turn ending in this reason leaves the agent stuck waiting on the
 * user, i.e. the notice belongs to the attention class rather than the
 * completion class. A turn that failed (API quota, provider capacity, a bad
 * request) or was blocked stops the agent and nothing else will happen until
 * the user acts - so it must reach them even while they are watching.
 * @param reason - the `TurnEndReason.kind`.
 * @returns true for attention-class reasons.
 */
export function isAttentionReason(reason) {
  return reason === 'error' || reason === 'blocked';
}

/**
 * Pure notification decision: hard mute, soft mute, foreground handling, and
 * the same-key dedupe window.
 *
 * Two classes of notice:
 *   - attention class (`attention: true`, or any `ask` sound) means "the agent
 *     is stuck and needs you". It ignores BOTH the soft mute and the
 *     foreground rule: hiding it can leave the agent blocked with nothing on
 *     screen to say so.
 *   - completion class is subject to both, per `foregroundMode`.
 * `muteAll` is the hard mute and outranks everything.
 *
 * @param cfg - the effective config.
 * @param soundType - 'done' | 'error' | 'ask' (picks the sound).
 * @param foregroundActive - whether the app currently has the user's attention.
 * @param lastNotifyAt - epoch ms of the last notice for this key, if any.
 * @param elapsedMs - the turn's duration in ms when known (used by
 *   `foregroundMode: 'long'`).
 * @param attention - true for attention-class notices.
 * @returns `{ action: 'notify', now }` or `{ action: 'skip', reason }`.
 */
export function decideNotify(cfg, soundType, foregroundActive, lastNotifyAt, elapsedMs, attention) {
  const c = cfg ?? {};
  // Hard mute (file-only) silences everything.
  if (c.muteAll === true) return { action: 'skip', reason: 'muted' };
  // `soundType === 'ask'` implies the attention class, so a caller that only
  // passes a soundType keeps the original ask/approval behaviour.
  const mustReach = attention === true || soundType === 'ask';
  if (!mustReach) {
    // Soft mute (the header bell) is for completions only.
    if (c.notifications === false) return { action: 'skip', reason: 'disabled' };
    if (foregroundActive && !foregroundAllowed(c, elapsedMs)) {
      return { action: 'skip', reason: 'foreground' };
    }
  }
  const now = Date.now();
  if (typeof lastNotifyAt === 'number' && now - lastNotifyAt < DEDUPE_MS) return { action: 'skip', reason: 'dedupe' };
  return { action: 'notify', now };
}

/** Pure construction of the powershell notify.ps1 argument list. */
export function buildNotifyArgs(cfg, sessionId, sessionName, detail, soundType) {
  const args = ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', NOTIFY_SCRIPT,
    '-Name', sessionName || 'DeepSeek Harness',
    '-Volume', String(typeof cfg.volume === 'number' ? cfg.volume : 1.0),
    '-Tag', String(sessionId || 'goal'),
    '-Url', 'http://127.0.0.1:3080'];
  if (detail) args.push('-Detail', String(detail));
  args.push('-SoundType', soundType);
  if (!cfg.sound) args.push('-NoSound');
  if (!cfg.toast) args.push('-NoToast');
  return args;
}

// --- spawn seam (test-injectable; production behavior unchanged) -------------
let _spawnOverride = null;
/** @internal test hook - inject a spy for the powershell spawn. */
export function __setSpawnForTests(fn) { _spawnOverride = fn; }
/** @internal test hook - reset module state between tests. */
export function __resetForTests() {
  pageActive = false;
  shellActive = false;
  langCache = null;
  turnStart.clear();
  lastNotify.clear();
  goalNoticeTurn.clear();
  _spawnOverride = null;
}
function spawnPowershell(args) {
  if (_spawnOverride) return _spawnOverride(args);
  try { return spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' }); }
  catch (e) { console.warn('[dsh-notify] spawn failed:', e?.message ?? e); }
}

// Turn-completion tracking off the session event stream.
// DSH 0.1.5-rc.1 appends `turn/start` / `turn/end` to the session log and
// publishes them on `session/event`; `turn/end` carries
// { turn, reason: { kind } } where kind is one of completed / aborted /
// blocked / error / max-tokens / interrupted. So the open turn is recorded on
// `turn/start` and settled on `turn/end` - no polling, and no access to the
// TypeScript-private `agent.phase` field.
const turnStart = new Map();     // sessionId -> { ts, turn } of the open turn
const lastNotify = new Map();    // notifyKey(id, soundType, kind) -> ts; 5s dedupe per kind
// sessionId -> turn number whose completion notice a goal-complete notice
// already covers. A goal completed by the model lands mid-turn (the tool call
// commits inside the turn), so `goal/changed(complete)` arrives BEFORE that
// turn's `turn/end` - without this pairing the user gets both "goal done" and
// "done" for one and the same moment, on two different dedupe keys.
const goalNoticeTurn = new Map();

/**
 * Dedupe key for one notice: `<id>:<kind>`.
 *
 * The kind discriminates notices that share a soundType. `ask` (a user
 * question) and `approval` (a permission request) both sound like "come back
 * and act", but collapsing them silently swallowed whichever came second - and
 * a swallowed approval leaves the agent blocked with nothing on screen to say
 * so. `turn` is shared by `turn/end` and `agent/error` on purpose: one failed
 * turn must not produce two toasts.
 *
 * @param sessionId - the session (or goal id) the notice belongs to.
 * @param soundType - 'done' | 'error' | 'ask'.
 * @param kind - the notice kind; defaults to the soundType.
 * @returns the `lastNotify` map key.
 */
export function notifyKey(sessionId, soundType, kind) {
  return String(sessionId ?? '') + ':' + (kind ?? soundType);
}

function notify(sessionId, sessionName, detail, soundType, elapsedMs, kind, attention) {
  const cfg = loadConfig();
  const key = notifyKey(sessionId, soundType, kind);
  const decision = decideNotify(cfg, soundType, foreground(), lastNotify.get(key), elapsedMs, attention);
  if (decision.action !== 'notify') return; // skipped calls leave no dedupe state
  lastNotify.set(key, decision.now);
  spawnPowershell(buildNotifyArgs(cfg, sessionId, sessionName, detail, soundType));
}

/**
 * Whether a session is a subagent child, whose turns must not notify.
 * `origin` is a SessionHeader field (`session.header.origin`), NOT a field of
 * the event envelope; a non-zero `delegationDepth` also marks a child, which
 * covers children whose coarse `origin` tag is absent.
 * @param session - the session the event belongs to.
 * @returns true when the session is a subagent child.
 */
export function isSubagentSession(session) {
  const header = session?.header;
  if (header === null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = header.delegationDepth;
  return typeof depth === 'number' && depth > 0;
}

/**
 * Toast detail for a settled turn: localized base copy plus elapsed time.
 * @param reason - the `TurnEndReason.kind` that closed the turn.
 * @param elapsedMs - turn duration in ms, or undefined when start was unseen.
 * @returns the detail string.
 */
export function turnDetail(reason, elapsedMs) {
  const base = trReason(reason);
  if (typeof elapsedMs !== 'number') return base;
  return base + ' · ' + (systemLang() === 'en' ? 'took ' : '耗时 ') + formatElapsed(elapsedMs);
}

/**
 * Whether an armed, active goal is continuing itself unattended right now.
 *
 * Ported from dsh-windows-notify's `isAutoContinuing`. When a goal is
 * `active`, its continuation is `armed`, and rounds remain under
 * `maxGoalRounds`, `dsh-goal-round-driver` starts the next round as soon as
 * the agent goes idle - so one completion toast per round would be pure noise
 * (a goal may run up to 256 rounds). Every other state is a real stopping
 * point that deserves a notice: `paused` / `blocked` / `complete`, a
 * `disarmed` goal (which needs an explicit resume before anything continues),
 * and an exhausted round budget.
 *
 * Services are read defensively: a deployment without `dsh-goal` composed, a
 * non-live agent, or any throw degrades to "not auto-continuing", so a missing
 * goal service can never silence a notice.
 *
 * @param ctx - the plugin context.
 * @param session - the session whose turn just settled.
 * @returns true when the completion notice should be skipped.
 */
export function isAutoContinuing(ctx, session) {
  try {
    const goals = ctx?.get?.('goals');
    if (goals === undefined || typeof goals.get !== 'function') return false;
    const agents = ctx?.get?.('agents');
    const agent = typeof agents?.get === 'function' ? agents.get(session?.id) : undefined;
    if (agent === undefined) return false;
    const goal = goals.get(agent);
    if (goal === undefined || goal === null) return false;
    if (goal.phase !== 'active') return false;
    if (goal.activation !== 'armed') return false;
    const cap = goal.maxGoalRounds;
    if (typeof cap === 'number' && goal.roundsStarted >= cap) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return true;
  return site === 'same-origin' || site === 'none';
}

// --- shared HTTP helpers (used by both webServer routes) ---------------------
function sendJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
/** Drain a request body, parse it as a JSON object, then call onOk or onBad. */
function readJsonBody(req, onOk, onBad) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('bad json');
      onOk(parsed);
    } catch { onBad(); }
  });
}

export function apply(ctx, config = {}) {
  // Completion is derived from the session event stream (`turn/start` /
  // `turn/end`); no agent-phase polling is involved.
  ctx.on('session/event', (session, event) => {
    // Subagent child sessions never notify (the skip key is the session
    // header, not a field on the event envelope).
    if (isSubagentSession(session)) return;

    if (event.type === 'turn/start') {
      turnStart.set(session.id, { ts: Date.now(), turn: event.data?.turn });
      return;
    }

    if (event.type === 'turn/end') {
      const started = turnStart.get(session.id);
      turnStart.delete(session.id);
      const elapsed = started !== undefined ? Date.now() - started.ts : undefined;
      const reason = event.data?.reason?.kind ?? 'completed';
      // A goal-complete notice delivered inside THIS turn already told the user
      // the work is over, so the turn-end notice would be a second toast for
      // one moment. Consume the marker either way (it must never leak into a
      // later turn) but only silence the completion case.
      const owedTurn = goalNoticeTurn.get(session.id);
      const goalAlreadyAnnounced = owedTurn !== undefined && owedTurn === event.data?.turn;
      if (owedTurn !== undefined) goalNoticeTurn.delete(session.id);
      // A failed or blocked turn stops the agent: it is attention class, so it
      // is never suppressed by the goal-round rule, the bell, or the foreground
      // rule - reporting it late is the same as not reporting it at all.
      const attention = isAttentionReason(reason);
      if (!attention) {
        if (goalAlreadyAnnounced) return;
        // An armed, active goal starts its next round immediately, so a
        // completion toast per round is noise.
        if (isAutoContinuing(ctx, session)) return;
      }
      notify(
        session.id,
        '「' + (titleOf(session) || tr('conv')) + '」',
        turnDetail(reason, elapsed),
        attention ? 'error' : 'done',
        elapsed,
        'turn',
        attention,
      );
      return;
    }

    // The agent is waiting for the user to choose/answer: the task is blocked
    // until the user acts, so notify immediately (no debounce).
    if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      // Row 2 = 「session name」; row 3 = subject only (no question text).
      notify(session.id, '「' + (titleOf(session) || tr('conv')) + '」', tr('ask'), 'ask', undefined, 'ask', true);
      return;
    }
    // `approval/asked` is a SESSION event (the audit record of an approval
    // question put to the answerer chain, data: { id, toolName, callId?,
    // reason? }) - it arrives here through session/event, not as a host-level
    // event of its own.
    if (event.type === 'approval/asked') {
      const tool = typeof event.data?.toolName === 'string' && event.data.toolName !== '' ? ': ' + event.data.toolName : '';
      notify(session.id, '「' + (titleOf(session) || tr('conv')) + '」', tr('approve') + tool, 'ask', undefined, 'approval', true);
      return;
    }
  });

  // Failures that never close a turn still surface as the host-level
  // `agent/error` event; a turn that fails with reason 'error' is already
  // covered above and is swallowed by the same-session dedupe window.
  ctx.on('agent/error', (payload) => {
    const agent = payload?.agent;
    const session = agent?.session ?? null;
    const sessionId = session?.id ?? agent?.id;
    if (!sessionId) return;
    const started = turnStart.get(sessionId);
    const elapsed = started !== undefined ? Date.now() - started.ts : undefined;
    notify(sessionId, '「' + (titleOf(session) || tr('conv')) + '」', turnDetail('error', elapsed), 'error', elapsed, 'turn', true);
  });

  ctx.on('goal/changed', ({ agent, change }) => {
    if (change?.operation === 'complete') {
      // Pair the notice with the turn that is still open, so that turn's
      // `turn/end` does not produce a second toast for the same moment.
      const goalSessionId = agent?.session?.id ?? agent?.id;
      const open = goalSessionId !== undefined ? turnStart.get(goalSessionId) : undefined;
      if (goalSessionId !== undefined && open !== undefined) goalNoticeTurn.set(goalSessionId, open.turn);
      // Empty -Name breaks PowerShell -File arg parsing; fall back to the app name.
      notify(change.ref?.id ?? 'goal', 'DeepSeek Harness', tr('goal'), 'done', undefined, 'goal');
    }
  });

  // Bell config API (same-origin browser fetches only).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: async (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return; }
        if (req.method === 'GET') { sendJson(res, loadConfig()); return; }
        if (req.method === 'POST') {
          readJsonBody(req,
            (patch) => { const next = { ...loadConfig(), ...patch }; saveConfig(next); sendJson(res, next); },
            () => sendText(res, 400, 'bad json'));
          return;
        }
        sendText(res, 405, 'method not allowed');
      },
    }), 'dsh-notify: config route');

    // Foreground-state API (in-memory, same-origin only). The web page and the
    // desktop shell POST their activity; GET returns the merged snapshot.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: FOREGROUND_ROUTE,
      handler: async (req, res) => {
        if (!isSameOrigin(req)) { sendText(res, 403, 'forbidden'); return; }
        if (req.method === 'GET') { sendJson(res, { page: pageActive, shell: shellActive, foreground: foreground() }); return; }
        if (req.method === 'POST') {
          readJsonBody(req,
            (patch) => {
              if (typeof patch.page === 'boolean') pageActive = patch.page;
              if (typeof patch.shell === 'boolean') shellActive = patch.shell;
              sendJson(res, { page: pageActive, shell: shellActive, foreground: foreground() });
            },
            () => sendText(res, 400, 'bad json'));
          return;
        }
        sendText(res, 405, 'method not allowed');
      },
    }), 'dsh-notify: foreground route');
  });

  console.log('[dsh-notify] plugin loaded (config: ' + configPath() + ')');
}
