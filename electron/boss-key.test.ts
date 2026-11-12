import assert from "node:assert/strict";
import test from "node:test";
import { createBossKeyController, normalizeBossShortcut } from "./boss-key";
import { DEFAULT_BOSS_SHORTCUT, type BossKeyState } from "../src/boss-key-types";

const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(patch: {
  saved?: unknown;
  occupied?: string[];
  write?: (shortcut: string) => Promise<void>;
  onTrigger?: () => Promise<void> | void;
  onRepeatTrigger?: () => void;
  onRestore?: () => Promise<void> | void;
  onState?: (state: BossKeyState) => void;
  actionTimeoutMs?: number;
} = {}) {
  const registered = new Map<string, () => void>();
  const occupied = new Set(patch.occupied);
  const removed: string[] = [];
  const writes: string[] = [];
  const states: BossKeyState[] = [];
  let triggerCount = 0, restoreCount = 0;
  const controller = await createBossKeyController({
    directory: "unused-in-memory-fixture",
    shortcuts: {
      register(shortcut, callback) {
        if (occupied.has(shortcut) || registered.has(shortcut)) return false;
        registered.set(shortcut, callback);
        return true;
      },
      unregister(shortcut) { registered.delete(shortcut); removed.push(shortcut); },
    },
    storage: {
      read: async () => "saved" in patch ? patch.saved : missing(),
      write: async shortcut => { await patch.write?.(shortcut); writes.push(shortcut); },
    },
    onTrigger: () => { triggerCount++; return patch.onTrigger?.(); },
    onRepeatTrigger: patch.onRepeatTrigger,
    onRestore: () => { restoreCount++; return patch.onRestore?.(); },
    onState: state => { states.push(state); patch.onState?.(state); },
    actionTimeoutMs: patch.actionTimeoutMs,
  });
  return { controller, registered, occupied, removed, writes, states,
    get triggerCount() { return triggerCount; }, get restoreCount() { return restoreCount; } };
}

test("boss shortcuts accept bounded keyboard combinations and reject accidental global typing keys", () => {
  assert.equal(normalizeBossShortcut(" shift + ctrl + b "), "Control+Shift+B");
  assert.equal(normalizeBossShortcut("CmdOrCtrl+Option+b"), DEFAULT_BOSS_SHORTCUT);
  assert.equal(normalizeBossShortcut("F8"), "F8");
  assert.equal(normalizeBossShortcut("Command+Alt+Left"), "Command+Alt+Left");
  for (const value of ["B", "Shift+B", "Control++B", "Control+Ctrl+B", "CmdOrCtrl+Ctrl+B", "Alt", "F25",
    "Control+Alt+B,Control+Alt+M", "Control+Alt+B\n", "constructor+B", "__proto__+B", "Control+constructor",
    "x".repeat(101), "open:https://example.com", null, {}])
    assert.throws(() => normalizeBossShortcut(value));
});

test("startup restores a saved key and registration failure remains an explicit nonfatal state", async () => {
  const saved = await fixture({ saved: { version: 1, shortcut: "F8" } });
  assert.deepEqual(saved.controller.getState(), { shortcut: "F8", registered: true, hidden: false, busy: false, error: null });
  const copy = saved.controller.getState(); copy.hidden = true;
  assert.equal(saved.controller.getState().hidden, false);
  saved.controller.dispose();
  const blocked = await fixture({ occupied: [DEFAULT_BOSS_SHORTCUT] });
  assert.equal(blocked.controller.getState().registered, false);
  assert.match(blocked.controller.getState().error!, /注册失败/);
  blocked.occupied.clear();
  assert.equal((await blocked.controller.setShortcut(DEFAULT_BOSS_SHORTCUT)).registered, true);
  assert.equal(blocked.controller.getState().error, null);
  blocked.controller.dispose();
  const corrupt = await fixture({ saved: { version: 1, shortcut: "B" } });
  assert.equal(corrupt.controller.getState().shortcut, DEFAULT_BOSS_SHORTCUT);
  assert.equal(corrupt.controller.getState().registered, true);
  assert.match(corrupt.controller.getState().error!, /配置暂不可读/);
  corrupt.controller.dispose();
});

test("a conflicting replacement never unregisters the old working shortcut", async () => {
  const current = await fixture({ occupied: ["Control+Alt+M"] });
  await assert.rejects(current.controller.setShortcut("Control+Alt+M"), /占用/);
  assert.equal(current.controller.getState().shortcut, DEFAULT_BOSS_SHORTCUT);
  assert.equal(current.controller.getState().registered, true);
  assert.equal(current.registered.has(DEFAULT_BOSS_SHORTCUT), true);
  assert.deepEqual(current.writes, []);
  current.registered.get(DEFAULT_BOSS_SHORTCUT)!();
  await current.controller.trigger();
  assert.equal(current.triggerCount, 1, "an active native callback remains usable after a conflict");
  assert.equal(current.controller.getState().hidden, true);
  const next = await current.controller.setShortcut("Control+Alt+N");
  assert.equal(next.shortcut, "Control+Alt+N");
  assert.equal(next.registered, true);
  assert.equal(current.registered.has(DEFAULT_BOSS_SHORTCUT), false);
  assert.equal(current.registered.has("Control+Alt+N"), true);
  assert.deepEqual(current.writes, ["Control+Alt+N"]);
  current.controller.dispose();
});

test("save failures release a reserved replacement while preserving the old registration and safe error", async () => {
  const current = await fixture({ write: async () => { throw new Error("private disk path or token"); } });
  await assert.rejects(current.controller.setShortcut("F8"), error => {
    assert.match((error as Error).message, /未能保存/);
    assert.doesNotMatch((error as Error).message, /private|token/);
    return true;
  });
  assert.equal(current.registered.has(DEFAULT_BOSS_SHORTCUT), true);
  assert.equal(current.registered.has("F8"), false);
  assert.equal(current.controller.getState().busy, false);
  assert.equal(current.controller.getState().shortcut, DEFAULT_BOSS_SHORTCUT);
  current.controller.dispose();
});

test("concealment begins synchronously and repeated keypresses cancel a waiting restore", async () => {
  const paused = gate();
  const current = await fixture({ onTrigger: () => paused.promise });
  const first = current.controller.trigger();
  assert.equal(current.triggerCount, 1, "the hide callback starts before trigger returns");
  assert.equal(current.controller.getState().hidden, true);
  assert.equal(current.controller.getState().busy, true);
  const restore = current.controller.restore();
  const repeat = current.controller.trigger();
  assert.equal(current.triggerCount, 1, "repeated keypresses coalesce pause work and never toggle visible");
  paused.resolve();
  await Promise.all([first, restore, repeat]);
  assert.equal(current.restoreCount, 0);
  assert.equal(current.controller.getState().hidden, true);
  assert.equal(current.controller.getState().busy, false);
  await current.controller.restore();
  assert.equal(current.restoreCount, 1);
  assert.equal(current.controller.getState().hidden, false);
  assert.equal(current.triggerCount, 1, "restoring windows does not invoke media playback work");
  current.controller.dispose();
});

test("a repeated pending trigger synchronously re-hides a reopened panel without duplicating pause work", async () => {
  const paused = gate();
  let visible = true, repeated = 0, failRepeat = false;
  const observedVisibility: boolean[] = [];
  const current = await fixture({
    onTrigger: () => { visible = false; return paused.promise; },
    onRepeatTrigger: () => {
      repeated++;
      visible = false;
      if (failRepeat) throw new Error("closing window");
    },
    onState: () => { observedVisibility.push(visible); },
  });
  const first = current.controller.trigger();
  visible = true; // A tray click may reopen the panel while media is acknowledging pause.
  observedVisibility.length = 0;
  const repeat = current.controller.trigger();
  assert.equal(visible, false, "re-hide happens before trigger returns");
  assert.deepEqual(observedVisibility, [false], "subscribers see the re-hidden window");
  assert.equal(repeat, first, "all repeats retain the original pending operation");
  assert.equal(current.triggerCount, 1, "the media pause callback only runs once");
  assert.equal(repeated, 1);
  const restore = current.controller.restore();
  visible = true;
  failRepeat = true;
  assert.equal(current.controller.trigger(), first, "a failing repeat hook does not replace pending work");
  assert.equal(visible, false);
  assert.equal(current.triggerCount, 1);
  paused.resolve();
  await Promise.all([first, repeat, restore]);
  assert.equal(current.restoreCount, 0, "the repeat still cancels a queued restore after its hook throws");
  assert.equal(current.controller.getState().hidden, true);
  assert.equal(current.controller.getState().busy, false);
  assert.equal(current.controller.getState().error, null);
  current.controller.dispose();
});

test("action failures and timeouts leave concealment requested without a popup or leaked details", async () => {
  const failed = await fixture({ onTrigger: () => { throw new Error("private media URL"); }, onState: () => { throw new Error("closed renderer"); } });
  await assert.rejects(failed.controller.trigger(), error => {
    assert.match((error as Error).message, /未确认暂停/);
    assert.doesNotMatch((error as Error).message, /private|URL|renderer/);
    return true;
  });
  assert.equal(failed.controller.getState().hidden, true);
  assert.equal(failed.controller.getState().busy, false);
  failed.controller.dispose();
  const stuck = await fixture({ onTrigger: () => new Promise(() => {}), actionTimeoutMs: 100 });
  await assert.rejects(stuck.controller.trigger(), /未确认暂停/);
  assert.equal(stuck.controller.getState().hidden, true);
  assert.equal(stuck.controller.getState().busy, false);
  await stuck.controller.restore();
  assert.equal(stuck.controller.getState().hidden, false);
  stuck.controller.dispose();
});

test("serialized preferences reserve the next key before releasing the old one and flush waits for persistence", async () => {
  const saved = gate(), entered = gate();
  const current = await fixture({ write: async shortcut => { if (shortcut === "F8") { entered.resolve(); await saved.promise; } } });
  const first = current.controller.setShortcut("F8");
  await entered.promise;
  const second = current.controller.setShortcut("F9");
  assert.equal(current.registered.has(DEFAULT_BOSS_SHORTCUT), true);
  assert.equal(current.registered.has("F8"), true);
  assert.equal(current.registered.has("F9"), false);
  let flushed = false;
  const flush = current.controller.flush().then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  saved.resolve();
  await Promise.all([first, second, flush]);
  assert.deepEqual(current.writes, ["F8", "F9"]);
  assert.deepEqual([...current.registered.keys()], ["F9"]);
  assert.equal(current.controller.getState().shortcut, "F9");
  current.controller.dispose();
});

test("disposal cancels pending actions and unregisters only keys owned by this controller", async () => {
  const current = await fixture({ onTrigger: () => new Promise(() => {}) });
  current.registered.set("Control+Alt+X", () => {});
  const operation = current.controller.trigger();
  const rejected = assert.rejects(operation, /未确认暂停/);
  current.controller.dispose();
  await rejected;
  assert.equal(current.controller.getState().registered, false);
  assert.deepEqual([...current.registered.keys()], ["Control+Alt+X"]);
  await assert.rejects(current.controller.trigger(), /已关闭/);
  await assert.rejects(current.controller.setShortcut("F8"), /已关闭/);
});
