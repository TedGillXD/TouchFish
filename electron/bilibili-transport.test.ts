import assert from "node:assert/strict";
import test from "node:test";
import { createBilibiliTransport } from "./bilibili-transport";
import type { BiliTransportCommand, BiliTransportReport, BiliTransportState } from "../src/bilibili-types";

const report = (revision: number, patch: Partial<BiliTransportReport> = {}): BiliTransportReport => ({
  revision, ready: true, playing: true, playIntent: true, buffering: false, ended: false, failed: false, ...patch,
});
function fixture(timeoutMs = 50) {
  const commands: BiliTransportCommand[] = [];
  const states: BiliTransportState[] = [];
  const controller = createBilibiliTransport({ send: command => commands.push(command), onState: state => states.push(state), timeoutMs });
  const revision = controller.beginSource();
  controller.report(report(revision));
  return { controller, revision, commands, states };
}

test("transport starts unavailable and accepts only a current-source, boolean player report", async () => {
  const controller = createBilibiliTransport({ send: () => assert.fail("No command should be sent"), onState: () => {} });
  await assert.rejects(controller.setPlaying(true, 0), /尚未就绪/);
  const revision = controller.beginSource();
  assert.equal(controller.getState().ready, false);
  assert.equal(controller.report(report(revision - 1)), false);
  assert.equal(controller.report({ ...report(revision), playing: "true" }), false);
  assert.equal(controller.report(report(revision)), true);
  assert.deepEqual(Object.keys(controller.getState()).sort(), ["revision", "open", "ready", "playing", "playIntent", "buffering", "ended", "failed"].sort());
  const copy = controller.getState();
  copy.playIntent = false;
  assert.equal(controller.getState().playIntent, true);
  controller.close();
});

test("play and pause complete only after the player acknowledges the matching command", async () => {
  const { controller, revision, commands } = fixture();
  const paused = controller.setPlaying(false, revision);
  const pauseCommand = commands.at(-1)!;
  assert.deepEqual(pauseCommand, { id: 1, revision, playing: false });
  assert.equal(controller.report(report(revision, { playing: false, playIntent: false }), pauseCommand.id), true);
  assert.equal((await paused).playIntent, false);
  const played = controller.setPlaying(true, revision);
  const playCommand = commands.at(-1)!;
  // A buffered play has been accepted, even while no frame is currently moving.
  controller.report(report(revision, { playing: false, buffering: true }), playCommand.id);
  const state = await played;
  assert.equal(state.playIntent, true);
  assert.equal(state.playing, false);
  assert.equal(state.buffering, true);
  controller.close();
});

test("a newer command supersedes an old request and ignores a delayed old acknowledgement", async () => {
  const { controller, revision, commands } = fixture();
  const first = controller.setPlaying(false, revision);
  const rejected = assert.rejects(first, /后续请求替换/);
  const old = commands.at(-1)!;
  const second = controller.setPlaying(true, revision);
  await rejected;
  const latest = commands.at(-1)!;
  assert.equal(controller.report(report(revision, { playing: false, playIntent: false }), old.id), false);
  assert.equal(controller.getState().playIntent, true);
  controller.report(report(revision), latest.id);
  assert.equal((await second).playing, true);
  controller.close();
});

test("switching source or closing cancels pending control and makes old reports powerless", async () => {
  const { controller, revision, commands } = fixture();
  const first = controller.setPlaying(false, revision);
  const firstRejected = assert.rejects(first, /来源已切换/);
  const oldCommand = commands.at(-1)!;
  const next = controller.beginSource();
  await firstRejected;
  assert.ok(next > revision);
  assert.equal(controller.report(report(revision), oldCommand.id), false);
  assert.equal(controller.getState().ready, false);
  controller.report(report(next));
  const second = controller.setPlaying(false, next);
  const secondRejected = assert.rejects(second, /已关闭/);
  controller.close();
  await secondRejected;
  assert.equal(controller.getState().open, false);
  assert.equal(controller.report(report(next)), false);
  const reopened = controller.beginSource();
  assert.ok(reopened > next);
  assert.equal(controller.getState().playIntent, false);
  controller.close();
});

test("invalid or stale controls cannot dispatch commands and a failed play cannot falsely succeed", async () => {
  const { controller, revision, commands } = fixture();
  await assert.rejects(controller.setPlaying("true", revision), /参数无效/);
  await assert.rejects(controller.setPlaying(true, revision - 1), /来源已切换/);
  assert.equal(commands.length, 0);
  const operation = controller.setPlaying(true, revision);
  const rejected = assert.rejects(operation, /操作未完成/);
  controller.report(report(revision, { playing: true, playIntent: true, failed: true }), commands.at(-1)!.id);
  await rejected;
  assert.equal(controller.getState().playing, false);
  assert.equal(controller.getState().playIntent, false);
  await assert.rejects(controller.setPlaying(true, revision), /播放器中重试/);
  controller.close();
});

test("a missing acknowledgement times out and a broken player channel rejects without leaking its error", async () => {
  const { controller, revision } = fixture(10);
  await assert.rejects(controller.setPlaying(false, revision), /响应超时/);
  controller.close();
  const broken = createBilibiliTransport({ send: () => { throw new Error("private channel payload"); }, onState: () => {} });
  const source = broken.beginSource();
  broken.report(report(source));
  await assert.rejects(broken.setPlaying(false, source), error => {
    assert.match((error as Error).message, /暂时无法响应/);
    assert.doesNotMatch((error as Error).message, /private/);
    return true;
  });
  broken.close();
});
