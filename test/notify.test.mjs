// dsh-notify test suite (node:test, zero deps).
//
// Runs against a throwaway DSH_HOME; the powershell spawn is replaced by a
// spy via the __setSpawnForTests hook, so no real powershell is ever started.
// Run with:  node --test test/
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as notify from "../lib/index.js";

let home;

/** The shipped config surface; `loadConfig()` must reproduce it exactly. */
const DEFAULTS = {
  sound: true,
  toast: true,
  volume: 1.0,
  serviceNotify: true,
  notifications: true,
  foregroundMode: "suppress",
  foregroundMinMs: 30000,
  muteAll: false,
};

beforeEach(() => {
  notify.__resetForTests();
  home = mkdtempSync(join(tmpdir(), "dsh-notify-test-"));
  process.env.DSH_HOME = home;
  process.env.DSH_NOTIFY_LANG = "zh";
});

function cleanup() {
  delete process.env.DSH_HOME;
  delete process.env.DSH_NOTIFY_LANG;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- pure helpers ---------------------------------------------------------------

describe("config", () => {
  test("defaults apply when no config file exists", () => {
    assert.deepEqual(notify.loadConfig(), DEFAULTS);
    cleanup();
  });

  test("saveConfig writes atomically and loadConfig reads it back merged", () => {
    notify.saveConfig({ volume: 0.5, notifications: false });
    const cfg = notify.loadConfig();
    assert.equal(cfg.volume, 0.5);
    assert.equal(cfg.notifications, false);
    assert.equal(cfg.sound, true, "unspecified keys keep defaults");
    assert.ok(existsSync(join(home, "dsh-notify.json")));
    assert.equal(existsSync(join(home, "dsh-notify.json.tmp")), false, "no tmp left behind");
    cleanup();
  });

  test("a corrupt config file falls back to defaults", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "dsh-notify.json"), "{not json");
    assert.deepEqual(notify.loadConfig(), DEFAULTS);
    cleanup();
  });

  test("a UTF-8 BOM does not silently reset every setting", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "dsh-notify.json"), "\uFEFF" + JSON.stringify({ foregroundMode: "always" }));
    const cfg = notify.loadConfig();
    assert.equal(cfg.foregroundMode, "always", "the BOM must not defeat the parse");
    assert.equal(cfg.sound, true, "unspecified keys keep defaults");
    cleanup();
  });

  test("a partial config file overrides only the keys it names", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "dsh-notify.json"), JSON.stringify({ muteAll: true }));
    const cfg = notify.loadConfig();
    assert.equal(cfg.muteAll, true);
    assert.equal(cfg.notifications, true, "the rest stays at its default");
    assert.equal(cfg.foregroundMode, "suppress");
    cleanup();
  });
});

describe("isSameOrigin", () => {
  test("same-origin / none / missing pass; cross-site rejected", () => {
    assert.equal(notify.isSameOrigin({ headers: { "sec-fetch-site": "same-origin" } }), true);
    assert.equal(notify.isSameOrigin({ headers: { "sec-fetch-site": "none" } }), true);
    assert.equal(notify.isSameOrigin({ headers: {} }), true);
    assert.equal(notify.isSameOrigin({ headers: { "sec-fetch-site": "cross-site" } }), false);
    assert.equal(notify.isSameOrigin({ headers: { "sec-fetch-site": "same-site" } }), false);
    cleanup();
  });
});

describe("titleOf", () => {
  test("latest session/title wins; blank titles ignored; 20-char cap", () => {
    assert.equal(notify.titleOf({ events: [{ type: "session/title", data: { title: "My Session" } }] }), "My Session");
    assert.equal(notify.titleOf({ events: [{ type: "session/title", data: { title: "first" } }, { type: "session/title", data: { title: "second" } }] }), "second");
    assert.equal(notify.titleOf({ events: [{ type: "session/title", data: { title: "   " } }] }), undefined);
    assert.equal(notify.titleOf({}), undefined);
    assert.equal(notify.titleOf(undefined), undefined);
    assert.equal(notify.titleOf({ events: [{ type: "session/title", data: { title: "x".repeat(40) } }] }).length, 20);
    cleanup();
  });

  test("reads the real Session shape via snapshotEvents()", () => {
    const session = {
      id: "s1",
      snapshotEvents: () => [{ type: "session/title", data: { title: "Real Session" } }],
    };
    assert.equal(notify.titleOf(session), "Real Session");
    cleanup();
  });
});

describe("formatElapsed", () => {
  test("zh formatting", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "zh";
    assert.equal(notify.formatElapsed(500), "1秒");
    assert.equal(notify.formatElapsed(90_000), "1分30秒");
    assert.equal(notify.formatElapsed(3_600_000), "1小时");
    cleanup();
  });

  test("en formatting", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "en";
    assert.equal(notify.formatElapsed(500), "1s");
    assert.equal(notify.formatElapsed(90_000), "1m 30s");
    assert.equal(notify.formatElapsed(3_600_000), "1h");
    cleanup();
  });
});

describe("systemLang / tr", () => {
  test("DSH_NOTIFY_LANG drives the language without touching the registry", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "en";
    assert.equal(notify.systemLang(), "en");
    assert.equal(notify.tr("done"), "Done");
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "zh";
    assert.equal(notify.systemLang(), "zh");
    assert.equal(notify.tr("done"), "完成");
    cleanup();
  });
});

describe("buildNotifyArgs", () => {
  const cfg = { sound: true, toast: true, volume: 1.0 };

  test("default argument shape", () => {
    const args = notify.buildNotifyArgs(cfg, "s1", "My Session", "", "done");
    assert.ok(args.includes("-NoProfile"));
    assert.ok(args.includes("-Name") && args[args.indexOf("-Name") + 1] === "My Session");
    assert.ok(args.includes("-Tag") && args[args.indexOf("-Tag") + 1] === "s1");
    assert.ok(args.includes("-Volume") && args[args.indexOf("-Volume") + 1] === "1");
    assert.ok(args.includes("-SoundType") && args[args.indexOf("-SoundType") + 1] === "done");
    assert.ok(!args.includes("-NoSound") && !args.includes("-NoToast"));
    cleanup();
  });

  test("sound/toast off append the flags; volume and detail pass through", () => {
    const args = notify.buildNotifyArgs({ sound: false, toast: false, volume: 0.35 }, "s1", "", "detail text", "error");
    assert.ok(args.includes("-NoSound"));
    assert.ok(args.includes("-NoToast"));
    assert.equal(args[args.indexOf("-Volume") + 1], "0.35");
    assert.equal(args[args.indexOf("-Detail") + 1], "detail text");
    assert.equal(args[args.indexOf("-Name") + 1], "DeepSeek Harness", "empty name falls back");
    cleanup();
  });
});

describe("decideNotify", () => {
  test("soft mute (the bell) spares ask; dedupe still applies", () => {
    const cfg = { notifications: true };
    const now = Date.now();
    // The bell is a SOFT mute: completion-class goes quiet, ask/approval does not.
    assert.equal(notify.decideNotify({ notifications: false }, "done", false, undefined).reason, "disabled");
    assert.equal(notify.decideNotify({ notifications: false }, "error", false, undefined).reason, "disabled");
    assert.equal(notify.decideNotify({ notifications: false }, "ask", false, undefined).action, "notify", "soft mute must not hide ask/approval");
    assert.equal(notify.decideNotify(cfg, "done", true, undefined).reason, "foreground");
    assert.equal(notify.decideNotify(cfg, "done", false, undefined).action, "notify");
    assert.equal(notify.decideNotify(cfg, "ask", true, undefined).action, "notify", "ask must interrupt foreground");
    assert.equal(notify.decideNotify(cfg, "done", false, now - 1000).reason, "dedupe");
    assert.equal(notify.decideNotify(cfg, "done", false, now - 10_000).action, "notify");
    cleanup();
  });

  test("hard mute (muteAll) silences everything, ask included", () => {
    const muted = { notifications: true, muteAll: true };
    assert.equal(notify.decideNotify(muted, "done", false, undefined).reason, "muted");
    assert.equal(notify.decideNotify(muted, "error", false, undefined).reason, "muted");
    assert.equal(notify.decideNotify(muted, "ask", false, undefined).reason, "muted");
    assert.equal(notify.decideNotify(muted, "ask", true, undefined).reason, "muted", "mute outranks foreground");
    // muteAll: false (the default) is not a mute
    assert.equal(notify.decideNotify({ notifications: true, muteAll: false }, "ask", true, undefined).action, "notify");
    cleanup();
  });

  test("foregroundMode decides who wins in the foreground", () => {
    const base = { notifications: true };
    assert.equal(notify.decideNotify({ ...base, foregroundMode: "suppress" }, "done", true, undefined, 600_000).reason, "foreground");
    assert.equal(notify.decideNotify({ ...base, foregroundMode: "always" }, "done", true, undefined, undefined).action, "notify");
    assert.equal(notify.decideNotify({ ...base, foregroundMode: "always" }, "done", true, undefined, 10).action, "notify");
    // 'long': only turns at or past the threshold get through
    const long = { ...base, foregroundMode: "long", foregroundMinMs: 30_000 };
    assert.equal(notify.decideNotify(long, "done", true, undefined, 29_999).reason, "foreground");
    assert.equal(notify.decideNotify(long, "done", true, undefined, 30_000).action, "notify");
    assert.equal(notify.decideNotify(long, "done", true, undefined, undefined).reason, "foreground", "unknown duration stays quiet");
    assert.equal(notify.decideNotify(long, "ask", true, undefined, 10).action, "notify", "ask is never gated");
    // an unrecognized mode falls back to suppressing
    assert.equal(notify.decideNotify({ ...base, foregroundMode: "nonsense" }, "done", true, undefined, 600_000).reason, "foreground");
    // background always notifies whatever the mode
    for (const mode of ["suppress", "always", "long", "nonsense"]) {
      assert.equal(notify.decideNotify({ ...base, foregroundMode: mode }, "done", false, undefined, 10).action, "notify");
    }
    cleanup();
  });

  test("attention-class ignores both the soft mute and the foreground", () => {
    const base = { notifications: true, foregroundMode: "suppress" };
    // The regression this covers: a failed turn was swallowed while the user
    // was watching the GUI, so the agent sat stuck with no signal.
    assert.equal(notify.decideNotify(base, "error", true, undefined, undefined, true).action, "notify");
    assert.equal(
      notify.decideNotify({ ...base, notifications: false }, "error", true, undefined, undefined, true).action,
      "notify",
      "the bell is only a soft mute",
    );
    assert.equal(
      notify.decideNotify({ ...base, muteAll: true }, "error", true, undefined, undefined, true).reason,
      "muted",
      "the hard mute still wins",
    );
    // Without the flag an error is ordinary completion-class (legacy callers).
    assert.equal(notify.decideNotify(base, "error", true, undefined, undefined).reason, "foreground");
    // `ask` implies the attention class with no extra flag.
    assert.equal(notify.decideNotify(base, "ask", true, undefined, undefined).action, "notify");
    // Dedupe still applies to attention notices.
    assert.equal(notify.decideNotify(base, "error", true, Date.now() - 1000, undefined, true).reason, "dedupe");
    cleanup();
  });
});

describe("foregroundAllowed", () => {
  test("mode semantics, independent of the rest of the decision", () => {
    assert.equal(notify.foregroundAllowed({ foregroundMode: "suppress" }, undefined), false);
    assert.equal(notify.foregroundAllowed({ foregroundMode: "always" }, undefined), true);
    assert.equal(notify.foregroundAllowed({ foregroundMode: "long", foregroundMinMs: 5000 }, 5000), true);
    assert.equal(notify.foregroundAllowed({ foregroundMode: "long", foregroundMinMs: 5000 }, 4999), false);
    assert.equal(notify.foregroundAllowed({ foregroundMode: "long" }, 30_000), true, "30s default threshold");
    assert.equal(notify.foregroundAllowed({ foregroundMode: "long" }, undefined), false);
    assert.equal(notify.foregroundAllowed(undefined, 600_000), false, "missing cfg degrades to suppress");
    cleanup();
  });
});

describe("isAttentionReason", () => {
  test("only error and blocked stop the agent on the user", () => {
    assert.equal(notify.isAttentionReason("error"), true);
    assert.equal(notify.isAttentionReason("blocked"), true);
    assert.equal(notify.isAttentionReason("completed"), false);
    assert.equal(notify.isAttentionReason("aborted"), false);
    assert.equal(notify.isAttentionReason("max-tokens"), false);
    assert.equal(notify.isAttentionReason("interrupted"), false);
    assert.equal(notify.isAttentionReason(undefined), false);
    cleanup();
  });
});

describe("notifyKey", () => {
  test("kind discriminates notices sharing a soundType", () => {
    assert.equal(notify.notifyKey("s1", "ask", "ask"), "s1:ask");
    assert.equal(notify.notifyKey("s1", "ask", "approval"), "s1:approval");
    assert.notEqual(notify.notifyKey("s1", "ask", "ask"), notify.notifyKey("s1", "ask", "approval"));
    assert.equal(notify.notifyKey("s1", "done"), "s1:done", "kind defaults to the soundType");
    assert.equal(notify.notifyKey("s1", "done", "turn"), "s1:turn");
    assert.equal(notify.notifyKey(undefined, "done", "goal"), ":goal", "a missing id does not throw");
    cleanup();
  });
});

describe("trReason / turnDetail", () => {
  test("every TurnEndReason kind gets its own label", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "zh";
    assert.equal(notify.trReason("completed"), "完成");
    assert.equal(notify.trReason("aborted"), "已中止");
    assert.equal(notify.trReason("blocked"), "被拦截");
    assert.equal(notify.trReason("error"), "出错");
    assert.equal(notify.trReason("max-tokens"), "达到 Token 上限");
    assert.equal(notify.trReason("interrupted"), "被中断");
    assert.equal(notify.trReason("brand-new-kind"), "brand-new-kind", "unknown kinds pass through");
    assert.equal(notify.trReason(undefined), "完成", "missing kind reads as completed");
    cleanup();
  });

  test("turnDetail labels the reason and appends elapsed", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "zh";
    assert.equal(notify.turnDetail("completed", undefined), "完成");
    assert.equal(notify.turnDetail("error", undefined), "出错");
    assert.equal(notify.turnDetail("max-tokens", undefined), "达到 Token 上限");
    assert.equal(notify.turnDetail("aborted", 90_000), "已中止 · 耗时 1分30秒");
    assert.equal(notify.turnDetail("completed", 90_000), "完成 · 耗时 1分30秒");
    cleanup();
  });

  test("English labels", () => {
    notify.__resetForTests();
    process.env.DSH_NOTIFY_LANG = "en";
    assert.equal(notify.trReason("completed"), "completed");
    assert.equal(notify.trReason("max-tokens"), "max tokens reached");
    assert.equal(notify.turnDetail("aborted", 90_000), "aborted · took 1m 30s");
    cleanup();
  });
});

describe("isSubagentSession", () => {
  test("header.origin or a non-zero delegationDepth marks a child session", () => {
    assert.equal(notify.isSubagentSession({ header: { origin: "subagent" } }), true);
    assert.equal(notify.isSubagentSession({ header: { delegationDepth: 2 } }), true);
    assert.equal(notify.isSubagentSession({ header: { origin: "subagent", delegationDepth: 1 } }), true);
    assert.equal(notify.isSubagentSession({ header: { delegationDepth: 0 } }), false);
    assert.equal(notify.isSubagentSession({ header: {} }), false);
    assert.equal(notify.isSubagentSession({}), false);
    assert.equal(notify.isSubagentSession(undefined), false);
    cleanup();
  });
});

describe("isAutoContinuing", () => {
  const fakeCtx = (services) => ({ get: (n) => services[n] });

  test("armed + active + rounds remaining is the only silencing state", () => {
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView())), { id: "s1" }), true);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ activation: "disarmed" }))), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ phase: "paused" }))), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ phase: "blocked" }))), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ phase: "complete" }))), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ roundsStarted: 256 }))), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(goalView({ roundsStarted: 300, maxGoalRounds: 256 }))), { id: "s1" }), false);
  });

  test("requires a resolved agent and a present goal", () => {
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(undefined)), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx(goalServices(null)), { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx({ goals: { get: () => goalView() } }), { id: "s1" }), false, "no agents service");
    assert.equal(notify.isAutoContinuing(fakeCtx({ agents: { get: () => ({ id: "s1" }) } }), { id: "s1" }), false, "no goals service");
  });

  test("a missing goal stack, a throw, or ctx without get() degrades to false", () => {
    assert.equal(notify.isAutoContinuing(undefined, { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing({}, { id: "s1" }), false);
    assert.equal(notify.isAutoContinuing(fakeCtx({ goals: {}, agents: { get: () => ({ id: "s1" }) } }), { id: "s1" }), false);
    const throwing = { get: () => { throw new Error("GoalError: not the live instance"); } };
    assert.equal(notify.isAutoContinuing(throwing, { id: "s1" }), false, "a throw must never silence a notice");
  });
});

// --- apply() wiring with a spawn spy and mocked HTTP server ----------------------

function makeHarness(services = {}) {
  const handlers = {};
  const routes = [];
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { fn(); return () => {}; },
    on: (name, fn) => { handlers[name] = fn; },
    inject: (deps, cb) => { cb(webCtx); },
  };
  const webCtx = {
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
  };
  notify.apply(ctx, {});
  return { handlers, routes };
}

/** A contexts fake whose `goals.get(agent)` always answers `goal`. */
function goalServices(goal) {
  const agent = { id: "s1", session: { id: "s1" } };
  return {
    goals: { get: () => goal },
    agents: { get: () => agent },
  };
}

/** A GoalView-shaped value; only the fields isAutoContinuing reads. */
function goalView(overrides = {}) {
  return { phase: "active", activation: "armed", roundsStarted: 3, maxGoalRounds: 256, ...overrides };
}

/**
 * Fire one session event. `opts.subagent` marks the SESSION a child session
 * (`session.header.origin`); `opts.sessionId` overrides the default id.
 */
function fireEvent(handlers, type, data, opts = {}) {
  const session = {
    id: opts.sessionId ?? "s1",
    events: [{ type: "session/title", data: { title: "My Session" } }],
    header: opts.subagent ? { origin: "subagent" } : {},
  };
  const event = { type, data, time: Date.now(), seq: 1 };
  handlers["session/event"](session, event);
  return { session, event };
}

/** Open and close one turn on the current session. */
function runTurn(handlers, reasonKind, opts = {}) {
  fireEvent(handlers, "turn/start", { turn: 1 }, opts);
  fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: reasonKind } }, opts);
}

/** Fire a goal-complete change carrying the owning agent, as DSH does. */
function fireGoalComplete(handlers, { sessionId = "s1", goalId = "g1" } = {}) {
  handlers["goal/changed"]({
    agent: { id: sessionId, session: { id: sessionId } },
    change: { operation: "complete", ref: { id: goalId } },
  });
}

/**
 * Reset module state and install a fresh spawn spy, for tests that need more
 * than one notification inside a single test body (the 5s per-session dedupe
 * would otherwise swallow every spawn after the first).
 */
function freshCalls() {
  notify.__resetForTests();
  const calls = [];
  notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
  return calls;
}

describe("apply() wiring", () => {
  test("session/event, agent/error and goal/changed handlers are registered", () => {
    const { handlers } = makeHarness();
    assert.equal(typeof handlers["session/event"], "function");
    assert.equal(typeof handlers["agent/error"], "function");
    assert.equal(typeof handlers["goal/changed"], "function");
    cleanup();
  });

  test("turn/start -> turn/end notifies once with SoundType done", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "turn/start", { turn: 3 });
    assert.equal(calls.length, 0, "turn/start alone does not notify");
    fireEvent(handlers, "turn/end", { turn: 3, reason: { kind: "completed" } });
    assert.equal(calls.length, 1, "turn/end notifies");
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "done");
    assert.equal(calls[0][calls[0].indexOf("-Name") + 1], "「My Session」");
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("完成"));
    cleanup();
  });

  test("turn/end reason 'error' notifies with SoundType error", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    runTurn(handlers, "error");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "error");
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("出错"));
    cleanup();
  });

  test("a non-completed reason still counts as done (max-tokens)", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    runTurn(handlers, "max-tokens");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "done");
    cleanup();
  });

  test("turn/end without a recorded turn/start still notifies, without elapsed", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(calls.length, 1);
    const detail = calls[0].includes("-Detail") ? calls[0][calls[0].indexOf("-Detail") + 1] : "";
    assert.ok(!detail.includes("耗时"), "no elapsed text when the start was unseen");
    cleanup();
  });

  test("an armed, active goal silences the per-round completion toast", () => {
    const { handlers } = makeHarness(goalServices(goalView()));
    const calls = freshCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "auto-continuing goal round must stay silent");
    cleanup();
  });

  test("every real stopping point still notifies", () => {
    const cases = [
      ["paused", goalView({ phase: "paused" })],
      ["blocked", goalView({ phase: "blocked" })],
      ["complete", goalView({ phase: "complete" })],
      ["disarmed", goalView({ activation: "disarmed" })],
      ["rounds exhausted", goalView({ roundsStarted: 256 })],
      ["no goal at all", undefined],
    ];
    for (const [label, goal] of cases) {
      const { handlers } = makeHarness(goalServices(goal));
      const calls = freshCalls();
      runTurn(handlers, "completed");
      assert.equal(calls.length, 1, `${label} must still notify`);
    }
    cleanup();
  });

  test("a failed round still notifies while a goal auto-continues", () => {
    const { handlers } = makeHarness(goalServices(goalView()));
    const calls = freshCalls();
    runTurn(handlers, "error");
    assert.equal(calls.length, 1, "an error is a real stopping point");
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "error");
    cleanup();
  });

  test("a deployment without dsh-goal behaves exactly as before", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 1);
    cleanup();
  });

  test("ask/approval still fire while a goal auto-continues", () => {
    const { handlers } = makeHarness(goalServices(goalView()));
    const calls = freshCalls();
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1, "a goal round that asks a question must interrupt");
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "ask");
    cleanup();
  });

  test("the toast detail carries the actual end reason", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    runTurn(handlers, "aborted");
    assert.equal(calls.length, 1);
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("已中止"), "aborted is not reported as completed");
    cleanup();
  });

  test("foregroundMode is read from the config file per notification", () => {
    const { handlers, routes } = makeHarness();
    const fg = routes.find((r) => r.path === "/dsh-notify/foreground");
    // freshCalls() resets the in-memory foreground state, so arm it after.
    const foregroundCalls = () => {
      const calls = freshCalls();
      const req = { method: "POST", headers: { "sec-fetch-site": "same-origin" }, on: (n, fn) => { if (n === "data") fn(Buffer.from('{"page":true}')); if (n === "end") fn(); } };
      const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
      fg.handler(req, res);
      return calls;
    };

    let calls = foregroundCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "the default suppresses foreground completions");

    // Flip the mode on disk; loadConfig() runs per notification, so no restart.
    notify.saveConfig({ ...notify.loadConfig(), foregroundMode: "always" });
    calls = foregroundCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 1, "'always' fires in the foreground");

    // 'long' gates on the recorded turn duration, which here is ~0ms.
    notify.saveConfig({ ...notify.loadConfig(), foregroundMode: "long", foregroundMinMs: 30_000 });
    calls = foregroundCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "a near-instant turn stays quiet under 'long'");
    cleanup();
  });

  test("the bell is a soft mute: ask/approval survive it", () => {
    const { handlers } = makeHarness();
    notify.saveConfig({ ...notify.loadConfig(), notifications: false });

    const calls = freshCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "completion-class goes quiet");
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1, "a soft mute must not hide a blocked agent");
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "ask");
    // A different kind is not silenced by the question's dedupe window.
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" });
    assert.equal(calls.length, 2, "approval survives the soft mute too");
    cleanup();
  });

  test("a question never swallows the approval that follows it", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1);
    // The user answers, and 2s later the agent asks for permission. Before the
    // kind-keyed dedupe this second notice vanished - and a swallowed approval
    // leaves the agent blocked with nothing on screen to say so.
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" });
    assert.equal(calls.length, 2, "the approval must reach the user");
    assert.equal(calls[1][calls[1].indexOf("-SoundType") + 1], "ask");
    assert.ok(calls[1][calls[1].indexOf("-Detail") + 1].includes("需要你批准"));
    cleanup();
  });

  test("repeats of the SAME kind still dedupe inside the window", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1, "two questions in a row are one event for the user");
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" });
    fireEvent(handlers, "approval/asked", { id: "a2", toolName: "shell" });
    assert.equal(calls.length, 2, "and two approvals are one event too");
    cleanup();
  });

  test("one failed turn still yields one toast (turn/end shares the 'turn' kind)", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    fireEvent(handlers, "turn/start", { turn: 1 });
    fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: "error" } });
    assert.equal(calls.length, 1, "turn/end reports the failure");
    handlers["agent/error"]({ agent: { id: "s1", session: { id: "s1" } } });
    assert.equal(calls.length, 1, "the follow-up agent/error must not double-report it");
    cleanup();
  });

  test("a completion and a goal notice do not silence each other", () => {
    const { handlers } = makeHarness();
    const calls = freshCalls();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 1);
    fireGoalComplete(handlers);
    assert.equal(calls.length, 2, "'turn' and 'goal' are separate kinds");
    cleanup();
  });

  test("a failed turn reaches the user even while the GUI is in the foreground", () => {
    const { handlers, routes } = makeHarness();
    const fg = routes.find((r) => r.path === "/dsh-notify/foreground");
    const setForeground = () => {
      const req = { method: "POST", headers: { "sec-fetch-site": "same-origin" }, on: (n, fn) => { if (n === "data") fn(Buffer.from('{"page":true}')); if (n === "end") fn(); } };
      const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
      fg.handler(req, res);
    };

    // The user is watching: this is exactly the state the reported bug hit.
    let calls = freshCalls();
    setForeground();
    runTurn(handlers, "error");
    assert.equal(calls.length, 1, "an error must not be silenced by foreground suppression");
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "error");
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("出错"));

    // ...while a plain completion in the same state stays quiet.
    calls = freshCalls();
    setForeground();
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "completion-class is still suppressed in the foreground");
    cleanup();
  });

  test("a failed turn survives the bell's soft mute", () => {
    const { handlers } = makeHarness();
    notify.saveConfig({ ...notify.loadConfig(), notifications: false });
    const calls = freshCalls();
    runTurn(handlers, "error");
    assert.equal(calls.length, 1, "muting completions must not hide a stuck agent");
    cleanup();
  });

  test("a failed turn is still silenced by the hard mute", () => {
    const { handlers } = makeHarness();
    notify.saveConfig({ ...notify.loadConfig(), muteAll: true });
    const calls = freshCalls();
    runTurn(handlers, "error");
    assert.equal(calls.length, 0, "muteAll is the escape hatch and outranks attention");
    cleanup();
  });

  test("blocked is attention-class, aborted is not", () => {
    const { handlers, routes } = makeHarness();
    const fg = routes.find((r) => r.path === "/dsh-notify/foreground");
    const setForeground = () => {
      const req = { method: "POST", headers: { "sec-fetch-site": "same-origin" }, on: (n, fn) => { if (n === "data") fn(Buffer.from('{"page":true}')); if (n === "end") fn(); } };
      const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
      fg.handler(req, res);
    };

    let calls = freshCalls();
    setForeground();
    runTurn(handlers, "blocked");
    assert.equal(calls.length, 1, "a blocked turn stops the agent too");
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("被拦截"));

    calls = freshCalls();
    setForeground();
    runTurn(handlers, "aborted");
    assert.equal(calls.length, 0, "a cancel the user asked for stays quiet");
    cleanup();
  });

  test("agent/error is attention-class as well", () => {
    const { handlers, routes } = makeHarness();
    const fg = routes.find((r) => r.path === "/dsh-notify/foreground");
    const calls = freshCalls();
    const req = { method: "POST", headers: { "sec-fetch-site": "same-origin" }, on: (n, fn) => { if (n === "data") fn(Buffer.from('{"page":true}')); if (n === "end") fn(); } };
    const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    fg.handler(req, res);
    handlers["agent/error"]({ agent: { id: "s1", session: { id: "s1" } } });
    assert.equal(calls.length, 1, "a non-turn failure also needs the user");
    cleanup();
  });

  test("muteAll is the hard mute and even hides ask", () => {
    const { handlers } = makeHarness();
    notify.saveConfig({ ...notify.loadConfig(), muteAll: true });
    const calls = freshCalls();
    runTurn(handlers, "completed");
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" });
    fireGoalComplete(handlers);
    assert.equal(calls.length, 0, "nothing gets through a hard mute");
    cleanup();
  });

  test("agent/error notifies immediately with SoundType error", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    handlers["agent/error"]({ agent: { id: "s1", session: { id: "s1", events: [{ type: "session/title", data: { title: "My Session" } }] } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "error");
    assert.equal(calls[0][calls[0].indexOf("-Name") + 1], "「My Session」");
    cleanup();
  });

  test("back-to-back turns in one session collapse into the 5s dedupe window", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    runTurn(handlers, "completed");
    runTurn(handlers, "completed");
    assert.equal(calls.length, 1, "second turn inside the dedupe window is swallowed");
    cleanup();
  });

  test("ask_user_question notifies immediately with SoundType ask", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "ask");
    cleanup();
  });

  test("approval/asked notifies with the tool name in the detail", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" });
    assert.equal(calls.length, 1);
    const detail = calls[0][calls[0].indexOf("-Detail") + 1];
    assert.ok(detail.includes("需要你批准") && detail.includes("write_file"));
    cleanup();
  });

  test("goal completion notifies with SoundType done", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    handlers["goal/changed"]({ change: { operation: "complete", ref: { id: "g1" } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-SoundType") + 1], "done");
    cleanup();
  });

  test("a goal completed inside a turn yields exactly one toast", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "turn/start", { turn: 1 });
    fireGoalComplete(handlers);
    assert.equal(calls.length, 1, "the goal notice fires");
    assert.equal(calls[0][calls[0].indexOf("-Name") + 1], "DeepSeek Harness");
    assert.ok(calls[0][calls[0].indexOf("-Detail") + 1].includes("目标完成"));
    fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(calls.length, 1, "the paired turn-end must NOT add a second toast");
    cleanup();
  });

  test("a goal completed outside a turn does not swallow a later turn-end", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireGoalComplete(handlers);
    assert.equal(calls.length, 1);
    runTurn(handlers, "completed");
    assert.equal(calls.length, 2, "an unrelated turn still notifies");
    cleanup();
  });

  test("the pairing never leaks into a later turn", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "turn/start", { turn: 1 });
    fireGoalComplete(handlers);
    fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.equal(calls.length, 1, "turn 1 collapsed into the goal notice");
    fireEvent(handlers, "turn/start", { turn: 2 });
    fireEvent(handlers, "turn/end", { turn: 2, reason: { kind: "completed" } });
    assert.equal(calls.length, 2, "turn 2 notifies normally");
    cleanup();
  });

  test("a failed turn still notifies even when the goal completed inside it", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "turn/start", { turn: 1 });
    fireGoalComplete(handlers);
    fireEvent(handlers, "turn/end", { turn: 1, reason: { kind: "error" } });
    assert.equal(calls.length, 2, "an error outranks the merge");
    assert.equal(calls[1][calls[1].indexOf("-SoundType") + 1], "error");
    cleanup();
  });

  test("subagent child sessions are skipped entirely", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    fireEvent(handlers, "tool/call", { name: "ask_user_question" }, { subagent: true });
    fireEvent(handlers, "approval/asked", { id: "a1", toolName: "write_file" }, { subagent: true });
    runTurn(handlers, "completed", { subagent: true });
    assert.equal(calls.length, 0);
    cleanup();
  });

  test("foreground suppresses done but ask still fires", () => {
    const { handlers, routes } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    // mark foreground via the route
    const fg = routes.find((r) => r.path === "/dsh-notify/foreground");
    const req = { method: "POST", headers: { "sec-fetch-site": "same-origin" }, on: (n, fn) => { if (n === "data") fn(Buffer.from('{"page":true}')); if (n === "end") fn(); } };
    const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    fg.handler(req, res);
    runTurn(handlers, "completed");
    assert.equal(calls.length, 0, "completion-class suppressed in foreground");
    fireEvent(handlers, "tool/call", { name: "ask_user_question" });
    assert.equal(calls.length, 1, "ask fires even in foreground");
    cleanup();
  });

  test("same-session dedupe: two error turns within 5s spawn once", () => {
    const { handlers } = makeHarness();
    const calls = [];
    notify.__setSpawnForTests((args) => { calls.push(args); return {}; });
    handlers["agent/error"]({ agent: { id: "s1", session: { id: "s1" } } });
    handlers["agent/error"]({ agent: { id: "s1", session: { id: "s1" } } });
    assert.equal(calls.length, 1);
    cleanup();
  });
});

// --- HTTP routes ---------------------------------------------------------------

function routeFor(routes, path) {
  const r = routes.find((x) => x.path === path);
  assert.ok(r, `route ${path} registered`);
  return r;
}
function makeReq(method, headers, body) {
  // Deliver any body synchronously when the handler subscribes, so the async
  // handler completes before `await handler(...)` resolves.
  return {
    method,
    headers,
    on: (n, fn) => {
      if (body !== undefined && n === "data") fn(Buffer.from(body));
      if (body !== undefined && n === "end") fn();
    },
  };
}
function makeRes() {
  return { status: 0, body: "", headers: {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
}

describe("HTTP /dsh-notify/config", () => {
  test("GET returns the merged config; POST updates and persists; bad json 400; cross-origin 403; PUT 405", async () => {
    const { routes } = makeHarness();
    const cfg = routeFor(routes, "/dsh-notify/config");

    const getRes = makeRes();
    await cfg.handler(makeReq("GET", { "sec-fetch-site": "same-origin" }), getRes);
    assert.equal(getRes.status, 200);
    assert.equal(JSON.parse(getRes.body).notifications, true);

    const postRes = makeRes();
    await cfg.handler(makeReq("POST", { "sec-fetch-site": "same-origin" }, '{"volume":0.4,"notifications":false}'), postRes);
    assert.equal(postRes.status, 200);
    assert.equal(JSON.parse(postRes.body).volume, 0.4);
    assert.equal(JSON.parse(readFileSync(join(home, "dsh-notify.json"), "utf8")).volume, 0.4, "persisted");

    const badRes = makeRes();
    await cfg.handler(makeReq("POST", { "sec-fetch-site": "same-origin" }, "{oops"), badRes);
    assert.equal(badRes.status, 400);

    const xRes = makeRes();
    await cfg.handler(makeReq("GET", { "sec-fetch-site": "cross-site" }), xRes);
    assert.equal(xRes.status, 403);

    const putRes = makeRes();
    await cfg.handler(makeReq("PUT", { "sec-fetch-site": "same-origin" }), putRes);
    assert.equal(putRes.status, 405);
    cleanup();
  });
});

describe("HTTP /dsh-notify/foreground", () => {
  test("GET reports the merged state; POST sets page/shell; bad json 400", async () => {
    const { routes } = makeHarness();
    const fg = routeFor(routes, "/dsh-notify/foreground");

    const get1 = makeRes();
    await fg.handler(makeReq("GET", { "sec-fetch-site": "same-origin" }), get1);
    assert.deepEqual(JSON.parse(get1.body), { page: false, shell: false, foreground: false });

    const post1 = makeRes();
    await fg.handler(makeReq("POST", { "sec-fetch-site": "same-origin" }, '{"page":true}'), post1);
    assert.equal(JSON.parse(post1.body).foreground, true);

    const get2 = makeRes();
    await fg.handler(makeReq("GET", { "sec-fetch-site": "same-origin" }), get2);
    assert.deepEqual(JSON.parse(get2.body), { page: true, shell: false, foreground: true });

    // non-boolean fields are silently ignored (lenient API), not an error
    const lenientRes = makeRes();
    await fg.handler(makeReq("POST", { "sec-fetch-site": "same-origin" }, '{"page":"yes"}'), lenientRes);
    assert.equal(lenientRes.status, 200);
    const still = makeRes();
    await fg.handler(makeReq("GET", { "sec-fetch-site": "same-origin" }), still);
    assert.deepEqual(JSON.parse(still.body), { page: true, shell: false, foreground: true }, "state unchanged");

    const badRes = makeRes();
    await fg.handler(makeReq("POST", { "sec-fetch-site": "same-origin" }, "{oops"), badRes);
    assert.equal(badRes.status, 400);
    cleanup();
  });
});
