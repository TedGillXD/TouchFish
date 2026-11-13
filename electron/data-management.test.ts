import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createDataManagement } from "./data-management";
import { createDataBackup, parseDataBackup, MAX_BACKUP_BYTES, type DataBackup } from "./data-backup-policy";
import { emptyData, startWork, type AppData } from "../src/core";
import type { DataManagementState } from "../src/data-management-types";

type Options = Parameters<typeof createDataManagement>[0];
const clone = <T>(value: T): T => structuredClone(value);
const at = (clock: string) => new Date(`2026-11-10T${clock}:00`).getTime();
function data(salary = 15000): AppData {
  const value = emptyData();
  value.settings.monthlySalary = salary;
  value.settings.alternateAnchor = "2026-11-09";
  value.settings.publicHolidays = false;
  return startWork(value, at("09:30"));
}
const backup = (salary = 45000) => createDataBackup({ data: data(salary), appVersion: "1.5.3", history: [],
  preferences: { bossShortcut: "CommandOrControl+Alt+B", floating: { enabled: true, expanded: false, privacy: true } } }, at("10:30"));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: TestContext, patch: Partial<Options> = {}) {
  const root = resolve(".cache", "data-management-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "case-"));
  let now = at("10:30"), live = data(), captureCalls = 0;
  let importPath: string | null = null, exportPath: string | null = null;
  const states: DataManagementState[] = [], applied: DataBackup[] = [], suggested: string[] = [];
  const manager = await createDataManagement({
    directory,
    capture: async () => { captureCalls++; return patch.capture ? patch.capture() : createDataBackup({ data: live, appVersion: "1.5.3", history: [] }, now); },
    apply: async snapshot => { applied.push(clone(snapshot)); if (patch.apply) await patch.apply(snapshot); live = clone(snapshot.data); },
    chooseImport: () => patch.chooseImport ? patch.chooseImport() : Promise.resolve(importPath),
    chooseExport: name => { suggested.push(name); return patch.chooseExport ? patch.chooseExport(name) : Promise.resolve(exportPath); },
    onState: state => { states.push(state); patch.onState?.(state); },
    now: () => now,
    ...(patch.gitOptions ? { gitOptions: patch.gitOptions } : {}),
  });
  t.after(async () => {
    manager.dispose();
    await manager.flush();
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(resolve(directory).startsWith(join(root, "case-")));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, manager, states, applied, suggested,
    get live() { return live; }, get captures() { return captureCalls; },
    setNow: (value: number) => { now = value; },
    setImport: (path: string | null) => { importPath = path; },
    setExport: (path: string | null) => { exportPath = path; },
    async input(value: unknown, name = "selected.json") {
      const path = join(directory, name); await writeFile(path, JSON.stringify(value)); importPath = path; return path;
    },
  };
}

test("canceling export or file selection does not capture, apply, or change local data", async t => {
  const f = await fixture(t), original = clone(f.live);
  assert.deepEqual(await f.manager.exportBackup(), { canceled: true });
  assert.equal(await f.manager.previewImport(), null);
  assert.equal(f.captures, 0);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.live, original);
  assert.equal(f.manager.getState().lastExportAt, null);
  assert.equal(f.manager.getState().busy, false);
  assert.match(f.suggested[0], /^TouchFish-backup-.+\.json$/);
});

test("export atomically writes a valid paused backup without pausing the live timer or leaking its directory", async t => {
  const f = await fixture(t), before = clone(f.live);
  f.setExport(join(f.directory, "my-backup.json"));
  assert.deepEqual(await f.manager.exportBackup(), { canceled: false, fileName: "my-backup.json" });
  const saved = parseDataBackup(await readFile(join(f.directory, "my-backup.json"), "utf8"));
  assert.equal(saved.data.records["2026-11-10"].intervals[0].to, at("10:30"));
  assert.equal(f.live.records["2026-11-10"].intervals[0].to, null);
  assert.deepEqual(f.live, before);
  assert.equal(f.captures, 1);
  assert.equal(f.applied.length, 0);
  assert.equal(f.manager.getState().lastExportAt, at("10:30"));
  assert.equal(f.manager.getState().error, null);
  const exposed = f.manager.getState(); exposed.message = "mutation";
  assert.notEqual(f.manager.getState().message, "mutation");
});

test("preview exposes only a summary, stages immutable data, and rejects forged or replayed identifiers", async t => {
  const f = await fixture(t), path = await f.input(backup());
  const preview = await f.manager.previewImport();
  assert.ok(preview);
  assert.match(preview.id, /^[a-f0-9]{48}$/);
  assert.deepEqual(Object.keys(preview).sort(), ["id", "source", "name", "exportedAt", "appVersion", "recordCount", "historyCount", "includesPreferences"].sort());
  assert.equal(preview.source, "file"); assert.equal(preview.name, "selected.json");
  assert.equal(preview.recordCount, 1); assert.equal(preview.historyCount, 0); assert.equal(preview.includesPreferences, true);
  assert.equal(f.captures, 0); assert.equal(f.applied.length, 0);
  await assert.rejects(f.manager.restorePreview("0".repeat(48)), /预览已过期/);
  await assert.rejects(f.manager.restorePreview({ id: preview.id } as any), /预览已过期/);
  assert.equal(f.applied.length, 0);
  // Changing the selected file after review cannot substitute another payload.
  await writeFile(path, JSON.stringify(backup(99999)));
  await f.manager.restorePreview(preview.id);
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].data.settings.monthlySalary, 45000);
  assert.equal(f.applied[0].data.records["2026-11-10"].intervals[0].to, at("10:30"));
  await assert.rejects(f.manager.restorePreview(preview.id), /预览已过期/);
  assert.equal(f.applied.length, 1);
});

test("cancel, replacement and ten-minute expiry revoke staged backups without calling apply", async t => {
  const f = await fixture(t); await f.input(backup());
  let preview = (await f.manager.previewImport())!;
  await f.manager.cancelPreview(preview.id);
  await assert.rejects(f.manager.restorePreview(preview.id), /预览已过期/);
  const old = (await f.manager.previewImport())!;
  preview = (await f.manager.previewImport())!;
  assert.notEqual(preview.id, old.id);
  await assert.rejects(f.manager.restorePreview(old.id), /预览已过期/);
  f.setNow(at("10:30") + 10 * 60_000);
  await assert.rejects(f.manager.restorePreview(preview.id), /预览已过期/);
  assert.equal(f.applied.length, 0); assert.equal(f.captures, 0);
  assert.equal(f.manager.getState().lastRestoreAt, null);
});

test("starting another file, recovery or remote selection revokes the old preview even when canceled or invalid", async t => {
  const f = await fixture(t), validPath = await f.input(backup(), "valid.json");
  let previous = (await f.manager.previewImport())!;
  f.setImport(null);
  assert.equal(await f.manager.previewImport(), null);
  await assert.rejects(f.manager.restorePreview(previous.id), /预览已过期/);

  f.setImport(validPath); previous = (await f.manager.previewImport())!;
  await f.input({ invalid: true }, "invalid.json");
  await assert.rejects(f.manager.previewImport(), /备份/);
  await assert.rejects(f.manager.restorePreview(previous.id), /预览已过期/);

  f.setImport(validPath); previous = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.previewRecovery(), /读取备份文件/);
  await assert.rejects(f.manager.restorePreview(previous.id), /预览已过期/);

  f.setImport(validPath); previous = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.previewRemote(), /Git|仓库/);
  await assert.rejects(f.manager.restorePreview(previous.id), /预览已过期/);
  assert.equal(f.applied.length, 0);
  assert.equal(f.captures, 0);
});

test("restore defaults to including preferences but can omit them without changing the reviewed backup", async t => {
  const f = await fixture(t); await f.input(backup());
  const preview = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.restorePreview(preview.id, "false" as any), /偏好选项无效/);
  assert.equal(f.captures, 0); assert.equal(f.applied.length, 0);
  await f.manager.restorePreview(preview.id, false);
  assert.equal(f.applied[0].preferences, undefined);
  assert.equal(f.applied[0].data.settings.monthlySalary, 45000);
  assert.deepEqual(f.applied[0].history, []);

  const again = (await f.manager.previewImport())!;
  assert.equal(again.includesPreferences, true);
  await f.manager.restorePreview(again.id);
  assert.deepEqual(f.applied[1].preferences, backup().preferences);
});

test("a failed preference apply can retry the same preview while leaving preferences out", async t => {
  const f = await fixture(t, { apply: async snapshot => {
    if (snapshot.preferences) throw new Error("快捷键已被占用，请重试。");
  } });
  await f.input(backup()); const preview = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.restorePreview(preview.id), /快捷键已被占用/);
  assert.equal(f.live.settings.monthlySalary, 15000);
  assert.equal(f.manager.getState().recoveryAvailable, true);
  await f.manager.restorePreview(preview.id, false);
  assert.equal(f.live.settings.monthlySalary, 45000);
  assert.equal(f.applied[1].preferences, undefined);
  assert.equal(f.manager.getState().error, null);
  await assert.rejects(f.manager.restorePreview(preview.id), /预览已过期/);
});

test("invalid JSON, data schema and oversized files fail before recovery capture or apply", async t => {
  const f = await fixture(t);
  const path = join(f.directory, "invalid.json"); f.setImport(path);
  for (const text of ["not json", JSON.stringify({ version: 1, settings: {}, records: {} }), JSON.stringify({ ...backup(), version: 999 }), " ".repeat(MAX_BACKUP_BYTES + 1)]) {
    await writeFile(path, text);
    await assert.rejects(f.manager.previewImport(), /备份/);
    assert.equal(f.captures, 0); assert.equal(f.applied.length, 0);
    assert.equal(f.manager.getState().busy, false);
    assert.ok(f.manager.getState().error);
    await assert.rejects(readFile(join(f.directory, "data-recovery.json")), { code: "ENOENT" });
  }
});

test("restore writes the prior snapshot before apply and recovery can restore it after restart", async t => {
  let recoverySeen = false;
  const f = await fixture(t, { apply: async () => {
    const prior = parseDataBackup(await readFile(join(f.directory, "data-recovery.json"), "utf8"));
    assert.equal(prior.data.settings.monthlySalary, 15000);
    assert.equal(prior.data.records["2026-11-10"].intervals[0].to, at("10:30"));
    recoverySeen = true;
  } });
  await f.input(backup()); const preview = (await f.manager.previewImport())!;
  await f.manager.restorePreview(preview.id);
  assert.equal(recoverySeen, true);
  assert.equal(f.live.settings.monthlySalary, 45000);
  assert.equal(f.manager.getState().recoveryAvailable, true);
  assert.equal(f.manager.getState().lastRestoreAt, at("10:30"));
  f.manager.dispose();
  let restored: DataBackup | null = null;
  const restarted = await createDataManagement({ directory: f.directory,
    capture: async () => createDataBackup({ data: f.live, appVersion: "1.5.3" }, at("10:30")),
    apply: async snapshot => { restored = snapshot; }, chooseImport: async () => null, chooseExport: async () => null, onState: () => {} });
  t.after(() => restarted.dispose());
  assert.equal(restarted.getState().recoveryAvailable, true);
  const recovery = await restarted.previewRecovery();
  assert.equal(recovery.source, "recovery");
  await restarted.restorePreview(recovery.id);
  assert.equal((restored as DataBackup | null)?.data.settings.monthlySalary, 15000);
  // Restoring recovery itself first protects the state that it is replacing.
  assert.equal(parseDataBackup(await readFile(join(f.directory, "data-recovery.json"), "utf8")).data.settings.monthlySalary, 45000);
});

test("legacy state import preserves omitted history/preferences and pauses an unknown open interval", async t => {
  const f = await fixture(t);
  const raw = data(7000) as unknown as Record<string, any>;
  delete raw.settings.dinner; delete raw.settings.publicHolidays; delete raw.settings.payroll; delete raw.settings.doubleRestDays;
  for (const key of ["dinnerStart", "dinnerEnd", "periodStart", "periodEnd"]) delete raw.records["2026-11-10"].plan[key];
  await f.input(raw, "state.json");
  const preview = (await f.manager.previewImport())!;
  assert.equal(preview.appVersion, null); assert.equal(preview.exportedAt, null);
  assert.equal(preview.historyCount, null); assert.equal(preview.includesPreferences, false);
  await f.manager.restorePreview(preview.id);
  assert.equal(f.applied[0].source, "legacy");
  assert.equal(f.applied[0].history, undefined); assert.equal(f.applied[0].preferences, undefined);
  assert.deepEqual(f.applied[0].data.records["2026-11-10"].intervals, [{ from: at("09:30"), to: at("09:30") }]);
});

test("failed apply retains a readable recovery and local error without leaking paths or credentials", async t => {
  const f = await fixture(t, { apply: async () => { throw new Error("failure C:\\private\\data token=secret-password"); } });
  await f.input(backup()); const preview = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.restorePreview(preview.id), /数据操作失败/);
  assert.equal(f.manager.getState().recoveryAvailable, true);
  assert.equal(f.manager.getState().lastRestoreAt, null);
  assert.equal(f.manager.getState().busy, false);
  assert.doesNotMatch(f.manager.getState().error!, /private|secret|password|token/);
  assert.equal(parseDataBackup(await readFile(join(f.directory, "data-recovery.json"), "utf8")).data.settings.monthlySalary, 15000);
  assert.equal(f.live.settings.monthlySalary, 15000);
  assert.equal((await f.manager.previewRecovery()).source, "recovery");
});

test("failed recovery persistence prevents apply and failed export keeps an existing destination intact", async t => {
  const f = await fixture(t);
  const blockedRecovery = join(f.directory, "data-recovery.json"); await mkdir(blockedRecovery);
  await writeFile(join(blockedRecovery, "keep.txt"), "original");
  await f.input(backup()); const preview = (await f.manager.previewImport())!;
  await assert.rejects(f.manager.restorePreview(preview.id), /保存失败/);
  assert.equal(f.applied.length, 0);
  assert.equal(await readFile(join(blockedRecovery, "keep.txt"), "utf8"), "original");
  assert.equal((await readdir(f.directory)).some(name => name.includes(".touchfish-") && name.endsWith(".tmp")), false);
  const blockedExport = join(f.directory, "blocked-export.json"); await mkdir(blockedExport);
  await writeFile(join(blockedExport, "keep.txt"), "original-export");
  f.setExport(blockedExport);
  await assert.rejects(f.manager.exportBackup(), /保存失败/);
  assert.equal(await readFile(join(blockedExport, "keep.txt"), "utf8"), "original-export");
  assert.equal((await readdir(f.directory)).some(name => name.includes(".touchfish-") && name.endsWith(".tmp")), false);
  f.setExport(join(f.directory, "recovered-export.json"));
  assert.equal((await f.manager.exportBackup()).canceled, false);
  assert.equal(f.manager.getState().error, null);
});

test("export cannot overwrite any managed application data or recovery file", async t => {
  const f = await fixture(t);
  for (const name of ["state.json", "state.backup.json", "state.tmp.json", "floating.json", "boss-key.json", "bilibili-history.json", "data-recovery.json", "git-sync.json"]) {
    const path = join(f.directory, name);
    await writeFile(path, `original ${name}`);
    f.setExport(path);
    await assert.rejects(f.manager.exportBackup(), /另存为新文件/);
    assert.equal(await readFile(path, "utf8"), `original ${name}`);
    if (process.platform === "win32") {
      f.setExport(join(f.directory, name.toUpperCase()));
      await assert.rejects(f.manager.exportBackup(), /另存为新文件/);
      assert.equal(await readFile(path, "utf8"), `original ${name}`);
    }
  }
  assert.equal(f.applied.length, 0);
  assert.equal((await readdir(f.directory)).some(name => name.includes(".touchfish-") && name.endsWith(".tmp")), false);
});

test("busy operations are mutually exclusive, flush awaits capture, and disposal prevents new work", async t => {
  const held = gate(); let entered = false;
  const f = await fixture(t, { capture: async () => { entered = true; await held.promise; return backup(); } });
  f.setExport(join(f.directory, "held.json"));
  const pending = f.manager.exportBackup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true); assert.equal(f.manager.getState().busy, true);
  await assert.rejects(f.manager.previewImport(), /已有数据操作/);
  await assert.rejects(f.manager.configureGit(null), /已有数据操作/);
  let flushed = false;
  const flush = f.manager.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  held.resolve();
  await pending; await flush;
  assert.equal(flushed, true); assert.equal(f.manager.getState().busy, false);
  assert.equal(f.states.some(state => state.busy), true);
  f.manager.dispose();
  await assert.rejects(f.manager.exportBackup(), /服务已关闭/);
});
