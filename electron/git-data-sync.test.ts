import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createGitDataSync, runGitProcess } from "./git-data-sync";
import type { GitSyncConfig, GitSyncState } from "../src/data-management-types";

const repository = "https://git.example.org/personal/private-backup.git";
const config: GitSyncConfig = { repository, branch: "main" };
const first = JSON.stringify({ format: "touchfish-test", settings: { salary: 15000 }, records: ["day-1"] });
const second = JSON.stringify({ format: "touchfish-test", settings: { salary: 16000 }, records: ["day-1", "day-2"] });
function valid(text: string) { const value = JSON.parse(text); assert.equal(value.format, "touchfish-test"); }
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const root = resolve(".cache/git-data-sync-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "case-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(resolve(directory).startsWith(join(root, "case-")));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return directory;
}
function fixtureGit(repo: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, extraEnv);
  return execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "core.hooksPath=", "--git-dir", repo, ...args], { env, input, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
async function remoteFixture(directory: string) {
  const repo = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "--template=", "--initial-branch=main", "--object-format=sha1", repo], { windowsHide: true, stdio: "pipe" });
  return repo;
}
function commitFiles(repo: string, files: Record<string, string>, parent: string | null = null) {
  const index = join(repo, "fixture-index");
  const env = { GIT_INDEX_FILE: index };
  fixtureGit(repo, parent ? ["read-tree", `${parent}^{tree}`] : ["read-tree", "--empty"], undefined, env);
  for (const [path, value] of Object.entries(files)) {
    const blob = fixtureGit(repo, ["hash-object", "--stdin", "-w", "--no-filters"], value);
    fixtureGit(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
  }
  const tree = fixtureGit(repo, ["write-tree"], undefined, env);
  const commit = fixtureGit(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Fixture commit"]);
  fixtureGit(repo, ["update-ref", "refs/heads/main", commit]);
  return commit;
}
async function controller(directory: string, remote: string, patch: Partial<Parameters<typeof createGitDataSync>[0]> = {}) {
  const states: GitSyncState[] = [];
  const service = await createGitDataSync({ directory: join(directory, "data"), onState: next => states.push(next), testRemote: () => remote, validateBackup: valid, ...patch });
  return { service, states };
}

test("Git configuration persists without connecting and never stores credentials", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const { service } = await controller(directory, remote);
  assert.equal(service.getState().config, null);
  await assert.rejects(service.upload(first), /先保存|先检查/);
  const saved = await service.configure(config);
  assert.equal(saved.busy, false);
  assert.equal(saved.gitAvailable, null);
  assert.equal(saved.remote, null);
  const disk = await readFile(join(directory, "data/git-sync.json"), "utf8");
  assert.deepEqual(JSON.parse(disk), { version: 1, config });
  assert.doesNotMatch(disk, /salary|records|password|token|Cookie/);
  const restarted = (await controller(directory, remote)).service;
  assert.deepEqual(restarted.getState().config, config);
  assert.equal(restarted.getState().remote, null);
  await assert.rejects(restarted.upload(first), /先检查/);
  await restarted.configure(null);
  assert.equal((await controller(directory, remote)).service.getState().config, null);
});

test("an empty private repository can receive one backup and download it without checkout", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const { service } = await controller(directory, remote);
  await service.configure(config);
  const checked = await service.check();
  assert.deepEqual(checked.remote, { commit: null, fileExists: false, bytes: 0 });
  assert.equal(checked.gitAvailable, true);
  const uploaded = await service.upload(first);
  const head = fixtureGit(remote, ["rev-parse", "refs/heads/main"]);
  assert.equal(uploaded.remote?.commit, head);
  assert.equal(uploaded.busy, false);
  assert.equal(fixtureGit(remote, ["show", `${head}:touchfish-backup.json`]), first);
  assert.equal(fixtureGit(remote, ["rev-list", "--count", "refs/heads/main"]), "1");
  assert.deepEqual(await service.download(), { text: first, commit: head });
  const oldTime = uploaded.lastSyncedAt;
  await service.upload(first);
  assert.equal(fixtureGit(remote, ["rev-list", "--count", "refs/heads/main"]), "1");
  assert.ok(service.getState().lastSyncedAt! >= oldTime!);
  await service.flush();
});

test("uploads preserve unrelated repository files and only append a commit", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const before = commitFiles(remote, { "README.md": "Personal backup repository", "nested/keep.txt": "keep", "touchfish-backup.json": first });
  const { service } = await controller(directory, remote);
  await service.configure(config); await service.check();
  const saved = await service.upload(second), after = saved.remote!.commit!;
  assert.equal(fixtureGit(remote, ["rev-parse", `${after}^`]), before);
  assert.equal(fixtureGit(remote, ["show", `${after}:README.md`]), "Personal backup repository");
  assert.equal(fixtureGit(remote, ["show", `${after}:nested/keep.txt`]), "keep");
  assert.equal(fixtureGit(remote, ["show", `${after}:touchfish-backup.json`]), second);
  assert.equal(fixtureGit(remote, ["rev-list", "--count", "refs/heads/main"]), "2");
});

test("an invalid or oversized remote backup never authorizes overwriting that file", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  commitFiles(remote, { "touchfish-backup.json": "{\"format\":\"unrelated-project\"}" });
  const { service } = await controller(directory, remote);
  await service.configure(config);
  await assert.rejects(service.check(), /不是有效/);
  assert.equal(service.getState().remote, null);
  await assert.rejects(service.upload(first), /先检查/);
  assert.match(fixtureGit(remote, ["show", "main:touchfish-backup.json"]), /unrelated-project/);
  commitFiles(remote, { "touchfish-backup.json": JSON.stringify({ format: "touchfish-test", data: "x".repeat(2048) }) });
  const small = (await controller(directory, remote, { maxBytes: 1024 })).service;
  await small.configure(config);
  await assert.rejects(small.check(), /过大/);
  assert.equal(small.getState().remote, null);
});

test("a remote directory or symbolic link with the backup name is never replaced", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  commitFiles(remote, { "touchfish-backup.json/unrelated.txt": "keep" });
  const { service } = await controller(directory, remote);
  await service.configure(config);
  await assert.rejects(service.check(), /不是有效/);
  assert.equal(fixtureGit(remote, ["show", "main:touchfish-backup.json/unrelated.txt"]), "keep");
  const link = fixtureGit(remote, ["hash-object", "-w", "--stdin", "--no-filters"], "some-private-file");
  const tree = fixtureGit(remote, ["mktree"], `120000 blob ${link}\ttouchfish-backup.json\n`);
  const commit = fixtureGit(remote, ["commit-tree", tree, "-m", "Fixture symlink"]);
  fixtureGit(remote, ["update-ref", "refs/heads/main", commit]);
  await assert.rejects(service.check(), /不是有效/);
  assert.equal(fixtureGit(remote, ["ls-tree", "main", "touchfish-backup.json"]).startsWith("120000"), true);
});

test("a remote advance after check requires a new explicit decision", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const before = commitFiles(remote, { "touchfish-backup.json": first });
  const { service } = await controller(directory, remote);
  await service.configure(config); await service.check();
  const changed = commitFiles(remote, { "touchfish-backup.json": second }, before);
  await assert.rejects(service.upload(first), /云端分支已变化/);
  assert.equal(fixtureGit(remote, ["rev-parse", "main"]), changed);
  assert.equal(service.getState().remote, null);
  await service.check();
  assert.equal((await service.download()).text, second);
});

for (const race of ["advance", "rewind", "delete"] as const) test(`explicit lease rejects a ${race} between fetch and push`, async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const ancestor = commitFiles(remote, { "touchfish-backup.json": first });
  const before = commitFiles(remote, { "touchfish-backup.json": first, "keep.txt": "newer" }, ancestor);
  let armed = false, calls = 0, changed: string | null = null;
  const { service } = await controller(directory, remote, { testRemote: () => {
    if (armed && ++calls === 3) {
      if (race === "advance") changed = commitFiles(remote, { "touchfish-backup.json": second }, before);
      else if (race === "rewind") { fixtureGit(remote, ["update-ref", "refs/heads/main", ancestor]); changed = ancestor; }
      else fixtureGit(remote, ["update-ref", "-d", "refs/heads/main"]);
    }
    return remote;
  } });
  await service.configure(config); await service.check(); armed = true;
  await assert.rejects(service.upload(second), /云端分支已变化/);
  if (race === "delete") assert.throws(() => fixtureGit(remote, ["rev-parse", "--verify", "refs/heads/main"]));
  else assert.equal(fixtureGit(remote, ["rev-parse", "main"]), changed);
  assert.equal(service.getState().remote, null);
});

test("an initially absent branch cannot replace another writer's first commit", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  let armed = false, calls = 0, changed = "";
  const { service } = await controller(directory, remote, { testRemote: () => {
    if (armed && ++calls === 2) changed = commitFiles(remote, { "touchfish-backup.json": first });
    return remote;
  } });
  await service.configure(config); await service.check(); armed = true;
  await assert.rejects(service.upload(second), /云端分支已变化/);
  assert.equal(fixtureGit(remote, ["rev-parse", "main"]), changed);
});

test("configuration and backup failures preserve old settings and expose local errors only", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const { service } = await controller(directory, remote);
  await service.configure(config); await service.check();
  await assert.rejects(service.configure({ repository: "https://token@github.com/u/r", branch: "main" }), /HTTPS|SSH/);
  assert.deepEqual(service.getState().config, config);
  await service.check();
  await assert.rejects(service.upload("{invalid, secret=password}"), /不是有效/);
  assert.doesNotMatch(service.getState().error!, /password|invalid|git\.example|\.git/);
  await writeFile(join(directory, "data/git-sync.tmp.json"), "", "utf8");
  await rm(join(directory, "data/git-sync.tmp.json"));
  await mkdir(join(directory, "data/git-sync.tmp.json"));
  await assert.rejects(service.configure(null), /未能保存/);
  assert.deepEqual(service.getState().config, config);
});

test("a missing system Git is explicit and can be retried after installation", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const { service } = await controller(directory, remote);
  await service.configure(config);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    await assert.rejects(service.check(), /未找到 Git/);
    assert.equal(service.getState().gitAvailable, false);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  assert.equal((await service.check()).gitAvailable, true);
});

test("private HTTPS authentication failures finish without prompting or leaking remote messages", async t => {
  const directory = await temporary(t);
  const server = createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture-only-no-real-account"' });
    response.end("password=private-fixture-do-not-show");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { service } = await controller(directory, `http://127.0.0.1:${(server.address() as { port: number }).port}/private.git`, { timeoutMs: 5000 });
  await service.configure(config);
  await assert.rejects(service.check(), /无法访问仓库/);
  assert.doesNotMatch(service.getState().error!, /password|fixture|127\.0\.0\.1|https:/);
  assert.equal(service.getState().busy, false);
  assert.equal(service.getState().remote, null);
});

test("authenticated smart HTTP uses a local credential helper for private check, upload and download", async t => {
  const directory = await temporary(t), remote = await remoteFixture(directory);
  const gitExec = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
  const backend = join(gitExec, process.platform === "win32" ? "git-http-backend.exe" : "git-http-backend");
  if (!existsSync(backend)) {
    t.skip("系统 Git 缺少可选的 git-http-backend 测试服务端；产品同步只需要 Git 客户端。");
    return;
  }
  const username = "touchfish-fixture-user", password = "touchfish-fixture-password-only";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  let challenged = 0, authenticated = 0;
  const cgiErrors: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== authorization) {
      challenged++; response.writeHead(401, { "WWW-Authenticate": 'Basic realm="TouchFish fixture"' }); response.end(); return;
    }
    authenticated++;
    const url = new URL(request.url!, "http://127.0.0.1");
    if (!url.pathname.startsWith("/remote.git/")) { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
    Object.assign(env, { GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1", GIT_EXEC_PATH: gitExec,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
      REMOTE_USER: username, REMOTE_ADDR: "127.0.0.1", SERVER_PROTOCOL: "HTTP/1.1" });
    const cgi = spawn(backend, [], { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    cgi.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    cgi.stdin.on("error", () => {});
    cgi.once("error", error => { cgiErrors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); });
    cgi.once("close", code => {
      if (code !== 0) cgiErrors.push(Buffer.concat(errors).toString("utf8"));
      const bytes = Buffer.concat(output);
      let boundary = bytes.indexOf("\r\n\r\n"), separator = 4;
      if (boundary < 0) { boundary = bytes.indexOf("\n\n"); separator = 2; }
      if (boundary < 0) { if (!response.headersSent) response.writeHead(500); response.end(); return; }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of bytes.subarray(0, boundary).toString("ascii").split(/\r?\n/)) {
        const colon = line.indexOf(":"); if (colon < 1) continue;
        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[key] = value;
      }
      if (!response.headersSent) response.writeHead(status, headers);
      response.end(bytes.subarray(boundary + separator));
    });
    cgi.stdin.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  fixtureGit(remote, ["config", "--local", "http.receivepack", "true"]);
  commitFiles(remote, { "README.md": "Only authenticated fixture requests may access this repository", "touchfish-backup.json": first });
  const cache = join(directory, "data", "git-sync-cache", `${createHash("sha256").update(JSON.stringify(config)).digest("hex")}.git`);
  await mkdir(dirname(cache), { recursive: true });
  execFileSync("git", ["init", "--bare", "--template=", "--object-format=sha1", cache], { windowsHide: true, stdio: "pipe" });
  const helper = join(directory, "fixture-credential-helper.cjs"), helperLog = join(directory, "helper-calls.jsonl");
  await writeFile(helper, `const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{const values=Object.fromEntries(input.trim().split(/\\r?\\n/).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));const matched=values.protocol==='http'&&values.host===${JSON.stringify(host)};fs.appendFileSync(${JSON.stringify(helperLog)},JSON.stringify({operation:process.argv[2],matched})+'\\n');if(process.argv[2]==='get'&&matched)process.stdout.write(${JSON.stringify(`username=${username}\npassword=${password}\n\n`)});});`, "utf8");
  const quote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
  fixtureGit(cache, ["config", "--local", "--add", "credential.helper", ""]);
  fixtureGit(cache, ["config", "--local", "--add", "credential.helper", `!${quote(process.execPath)} ${quote(helper)}`]);
  const { service } = await controller(directory, `http://${host}/remote.git`, { timeoutMs: 10000 });
  await service.configure(config);
  assert.equal((await service.check()).remote?.fileExists, true);
  const uploaded = await service.upload(second);
  assert.equal(fixtureGit(remote, ["show", "main:touchfish-backup.json"]), second);
  assert.equal(fixtureGit(remote, ["show", "main:README.md"]), "Only authenticated fixture requests may access this repository");
  assert.deepEqual(await service.download(), { text: second, commit: uploaded.remote!.commit });
  await service.flush();
  assert.ok(challenged > 0 && authenticated > 0);
  const calls = (await readFile(helperLog, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(calls.some(call => call.operation === "get" && call.matched === true));
  assert.deepEqual(cgiErrors, []);
  const durable = await readFile(join(directory, "data/git-sync.json"), "utf8");
  const cacheConfig = await readFile(join(cache, "config"), "utf8");
  for (const value of [JSON.stringify(service.getState()), durable, cacheConfig, fixtureGit(remote, ["show", "main:touchfish-backup.json"])]) {
    assert.ok(!value.includes(username) && !value.includes(password));
  }
});

test("process limits, cancellation and disposal stop owned work without leaking native output", async t => {
  const directory = await temporary(t);
  const env = { ...process.env };
  await assert.rejects(runGitProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: directory, env, timeout: 100 }), /超时/);
  const abort = new AbortController();
  const pending = runGitProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: directory, env, timeout: 10000, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /取消/);
  await assert.rejects(runGitProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { cwd: directory, env, limit: 100 }), /过大/);
  const remote = await remoteFixture(directory), { service } = await controller(directory, remote);
  service.dispose();
  await assert.rejects(service.check(), /已关闭/);
});
