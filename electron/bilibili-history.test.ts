import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createBilibiliHistory } from "./bilibili-history";
import type { BiliPlayback, BiliVideo } from "../src/bilibili-types";
import type { BiliHistoryEntry, BiliHistoryState } from "../src/bilibili-history-types";

const A = "BV17x411w7KC", B = "BV1xx411c7mD";
const video = (bvid = A): BiliVideo => ({ bvid, title: "一段公开视频", owner: "UP 主", duration: 120, cover: "https://i0.hdslb.com/cover.jpg",
  pages: [{ cid: 101, page: 1, title: "第一部分", duration: 120 }] });
const playback = (bvid = A): BiliPlayback => ({ video: video(bvid), cid: 101, mode: "video", quality: 16, qualities: [{ id: 16, label: "360P" }],
  videoUrl: "touchfish-media://private/video", audioUrl: "touchfish-media://private/audio", expiresAt: 123_456 });
const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
const clone = <T>(value: T): T => structuredClone(value);
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(patch: { saved?: unknown; read?: () => Promise<unknown>; write?: (snapshot: { version: 1; entries: BiliHistoryEntry[] }) => Promise<void> } = {}) {
  let now = 1000;
  const writes: { version: 1; entries: BiliHistoryEntry[] }[] = [], states: BiliHistoryState[] = [];
  const controller = await createBilibiliHistory({ directory: "unused-in-memory-fixture", now: () => now,
    onState: state => states.push(state), storage: {
      read: patch.read ?? (async () => "saved" in patch ? clone(patch.saved) : missing()),
      write: async snapshot => { await patch.write?.(snapshot); writes.push(clone(snapshot)); },
    } });
  return { controller, writes, states, at: (time: number) => { now = time; } };
}
async function temporaryDirectory(t: { after: (action: () => Promise<void>) => void }) {
  const root = resolve(".cache", "bilibili-history-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "case-"));
  t.after(async () => {
    // Restrict recursive cleanup to the exact test directory created above.
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(resolve(directory).startsWith(join(root, "case-")));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("history persists across restarts without storing media URLs, covers, pages or account data", async t => {
  const directory = await temporaryDirectory(t);
  const controller = await createBilibiliHistory({ directory, now: () => 1000, onState: () => {} });
  assert.deepEqual(controller.getState(), { entries: [], error: null });
  await controller.recordSearch(`https://www.bilibili.com/video/${A}?from=private-search-query`);
  await controller.recordVideo(video());
  await controller.recordPlay({ ...playback(), mode: "audio", cid: 202 });
  await controller.flush();
  const saved = await readFile(join(directory, "bilibili-history.json"), "utf8");
  assert.doesNotMatch(saved, /touchfish-media|private-search-query|cover\.jpg|qualities|pages|expiresAt|videoUrl|audioUrl/);
  const restarted = await createBilibiliHistory({ directory, onState: () => {} });
  assert.deepEqual(restarted.getState(), controller.getState());
  assert.deepEqual(restarted.getState().entries[0], { bvid: A, title: "一段公开视频", owner: "UP 主", duration: 120,
    lastSearchedAt: 1000, lastPlayedAt: 1000, lastMode: "audio", lastCid: 202 });
  const snapshot = restarted.getState(); snapshot.entries[0].title = "mutated"; snapshot.entries.length = 0;
  assert.equal(restarted.getState().entries[0].title, "一段公开视频");
});

test("search and playback merge by BV while retaining separate dates, mode, part and newest-first order", async () => {
  const f = await fixture();
  await f.controller.recordSearch(A);
  f.at(2000); await f.controller.recordSearch(B);
  assert.deepEqual(f.controller.getState().entries.map(entry => entry.bvid), [B, A]);
  f.at(3000); await f.controller.recordPlay({ ...playback(), mode: "audio", cid: 202 });
  assert.deepEqual(f.controller.getState().entries.map(entry => entry.bvid), [A, B]);
  assert.equal(f.controller.getState().entries[0].lastSearchedAt, 1000);
  f.at(4000); await f.controller.recordSearch(A);
  assert.equal(f.controller.getState().entries.length, 2);
  assert.equal(f.controller.getState().entries[0].lastPlayedAt, 3000);
  assert.equal(f.controller.getState().entries[0].lastMode, "audio");
  assert.equal(f.controller.getState().entries[0].lastCid, 202);
  // Different actions in one clock millisecond still place the newest action first.
  await f.controller.recordSearch(B);
  assert.deepEqual(f.controller.getState().entries.map(entry => entry.bvid), [B, A]);
  await f.controller.recordVideo({ ...video(), title: "更新后的标题" });
  assert.deepEqual(f.controller.getState().entries.map(entry => entry.bvid), [B, A]);
  assert.equal(f.controller.getState().entries[1].title, "更新后的标题");
});

test("removal and clear persist and a late metadata response cannot recreate a deleted entry", async () => {
  const f = await fixture();
  await f.controller.recordSearch(A); await f.controller.recordSearch(B);
  await f.controller.remove(A);
  const writes = f.writes.length;
  await f.controller.recordVideo(video());
  assert.equal(f.writes.length, writes);
  assert.deepEqual(f.controller.getState().entries.map(entry => entry.bvid), [B]);
  await f.controller.clear(); await f.controller.recordVideo(video(B));
  assert.deepEqual(f.controller.getState().entries, []);
  assert.deepEqual(f.writes.at(-1), { version: 1, entries: [] });
  await f.controller.recordSearch(A); await f.controller.recordVideo(video());
  assert.equal(f.controller.getState().entries[0].title, video().title);
});

test("player refreshes update existing parts and modes but cannot recreate a deleted or cleared record", async () => {
  const f = await fixture();
  await f.controller.recordSearch(A);
  f.at(2000);
  await f.controller.recordPlay({ ...playback(), mode: "audio", cid: 202 }, false);
  assert.equal(f.controller.getState().entries[0].lastSearchedAt, 1000);
  assert.equal(f.controller.getState().entries[0].lastPlayedAt, 2000);
  assert.equal(f.controller.getState().entries[0].lastMode, "audio");
  assert.equal(f.controller.getState().entries[0].lastCid, 202);
  // The existence check runs inside the queue, after the pending deletion.
  const removed = f.controller.remove(A);
  const retried = f.controller.recordPlay(playback(), false);
  await Promise.all([removed, retried]);
  assert.deepEqual(f.controller.getState().entries, []);
  assert.equal(f.writes.length, 3);
  await f.controller.recordPlay(playback(), true);
  assert.equal(f.controller.getState().entries[0].bvid, A);
  const cleared = f.controller.clear();
  const refreshed = f.controller.recordPlay({ ...playback(), cid: 303 }, false);
  await Promise.all([cleared, refreshed]);
  assert.deepEqual(f.controller.getState().entries, []);
  await f.controller.recordPlay(playback());
  assert.equal(f.controller.getState().entries[0].lastMode, "video");
});

test("serialized writes and flush cannot let a pending search overwrite a later delete", async () => {
  const started = gate(), release = gate();
  let writeCount = 0;
  const f = await fixture({ write: async () => { if (!writeCount++) { started.resolve(); await release.promise; } } });
  const search = f.controller.recordSearch(A);
  await started.promise;
  const removed = f.controller.remove(A), lateMetadata = f.controller.recordVideo(video());
  let flushed = false;
  const flush = f.controller.flush().then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  assert.deepEqual(f.controller.getState().entries, []);
  release.resolve(); await Promise.all([search, removed, lateMetadata, flush]);
  assert.deepEqual(f.writes.map(write => write.entries.map(entry => entry.bvid)), [[A], []]);
  assert.deepEqual(f.controller.getState().entries, []);
});

test("failed deletes and clears keep committed records and expose no filesystem or credential details", async () => {
  let fail = false;
  const f = await fixture({ write: async () => { if (fail) throw new Error("D:\\private\\SESSDATA=secret"); } });
  await f.controller.recordSearch(A);
  fail = true;
  await assert.rejects(f.controller.remove(A), /保存失败/);
  assert.equal(f.controller.getState().entries[0].bvid, A);
  assert.doesNotMatch(f.controller.getState().error!, /private|secret|SESSDATA|D:/);
  await assert.rejects(f.controller.flush(), /保存失败/);
  await assert.rejects(f.controller.clear(), /保存失败/);
  assert.equal(f.controller.getState().entries.length, 1);
  fail = false; await f.controller.clear(); await f.controller.flush();
  assert.deepEqual(f.controller.getState(), { entries: [], error: null });
});

test("unreadable or unknown-version history is preserved until an explicit successful clear", async () => {
  for (const saved of [null, { version: 2, entries: [] }, { version: 1, entries: [{}] }]) {
    const f = await fixture({ saved });
    assert.match(f.controller.getState().error!, /无法读取/);
    await assert.rejects(f.controller.recordSearch(A), /无法读取/);
    assert.equal(f.writes.length, 0);
    await f.controller.clear(); await f.controller.recordSearch(A);
    assert.equal(f.controller.getState().error, null);
    assert.equal(f.controller.getState().entries[0].bvid, A);
  }
  const failedRead = await fixture({ read: async () => { throw new Error("private-path-and-password"); } });
  assert.doesNotMatch(failedRead.controller.getState().error!, /private|password/);
});

test("invalid JSON and an oversized disk history are never overwritten by a new search", async t => {
  const directory = await temporaryDirectory(t), path = join(directory, "bilibili-history.json");
  for (const content of ["{bad-json", " ".repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(path, content);
    const controller = await createBilibiliHistory({ directory, onState: () => {} });
    assert.match(controller.getState().error!, /无法读取/);
    await assert.rejects(controller.recordSearch(A));
    assert.equal((await stat(path)).size, Buffer.byteLength(content));
    await controller.clear();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, entries: [] });
  }
});

test("invalid inputs and invalid playback cannot create history and metadata remains bounded inert text", async () => {
  const f = await fixture();
  for (const input of ["", null, "BV-invalid", "https://evil.invalid/video/" + A, { bvid: A }]) {
    await assert.rejects(f.controller.recordSearch(input));
    await assert.rejects(f.controller.remove(input));
  }
  for (const patch of [{ mode: "invalid" }, { cid: -1 }, { cid: 1.5 }])
    await assert.rejects(f.controller.recordPlay({ ...playback(), ...patch } as BiliPlayback));
  assert.equal(f.writes.length, 0);
  f.at(Number.NaN); await assert.rejects(f.controller.recordSearch(A), /系统时间/);
  f.at(1000); await f.controller.recordSearch(A);
  await f.controller.recordVideo({ ...video(), title: "\u0000" + "标题".repeat(100), owner: "UP\n主", duration: Infinity });
  assert.equal(f.controller.getState().entries[0].title.length, 160);
  assert.equal(f.controller.getState().entries[0].owner, "UP 主");
  assert.equal(f.controller.getState().entries[0].duration, 0);
  const emitted = f.states.at(-1)!; emitted.entries[0].title = "mutated";
  assert.notEqual(f.controller.getState().entries[0].title, "mutated");
});

test("valid duplicate disk records merge search and play facts without discarding either date", async () => {
  const search: BiliHistoryEntry = { bvid: A, title: "先搜索", owner: "UP", duration: 12,
    lastSearchedAt: 1000, lastPlayedAt: null, lastMode: null, lastCid: null };
  const played: BiliHistoryEntry = { ...search, title: "后播放", lastSearchedAt: null, lastPlayedAt: 3000, lastMode: "video", lastCid: 101 };
  const f = await fixture({ saved: { version: 1, entries: [search, played] } });
  assert.deepEqual(f.controller.getState(), { entries: [{ ...played, lastSearchedAt: 1000 }], error: null });
});
