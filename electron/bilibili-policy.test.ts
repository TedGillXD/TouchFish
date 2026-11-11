import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBvid, normalizeBiliMediaUrl, parseDanmakuXml, safeBiliError, signWbi, trustedBiliApiUrl, trustedBiliMediaUrl } from "./bilibili-policy";

test("BV input accepts a complete ID or official video link without opening an arbitrary URL", () => {
  assert.equal(normalizeBvid("  bv1xx411c7mD  "), "BV1xx411c7mD");
  assert.equal(normalizeBvid("https://www.bilibili.com/video/BV1xx411c7mD/?p=2"), "BV1xx411c7mD");
  for (const value of ["", "av123", "BV1bad", "BV1xx411c7mD;quit", "file:///BV1xx411c7mD", "https://evil.example/video/BV1xx411c7mD", "https://user:password@www.bilibili.com/video/BV1xx411c7mD", "https://www.bilibili.com:8443/video/BV1xx411c7mD", null])
    assert.throws(() => normalizeBvid(value));
});

test("API and CDN requests allow only their fixed HTTPS origins and reject credentials or local hosts", () => {
  assert.equal(trustedBiliApiUrl("https://api.bilibili.com/x/web-interface/nav").hostname, "api.bilibili.com");
  assert.equal(trustedBiliMediaUrl("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/file.m4s").hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(trustedBiliMediaUrl("https://xy-peer.mcdn.bilivideo.cn/file.m4s").protocol, "https:");
  for (const value of ["http://api.bilibili.com/nav", "https://api.bilibili.com.evil.example/", "https://localhost/", "https://127.0.0.1/", "https://api.bilibili.com:8443/", "https://user:password@api.bilibili.com/"])
    assert.throws(() => trustedBiliApiUrl(value));
  for (const value of ["http://cdn.bilivideo.com/file", "https://bilivideo.com.evil.example/file", "https://192.168.1.1/file", "https://cdn.bilivideo.com:8080/file", "https://user:password@cdn.bilivideo.com/file", "data:video/mp4;base64,AAAA"])
    assert.throws(() => trustedBiliMediaUrl(value));
  assert.equal(normalizeBiliMediaUrl("http://i0.hdslb.com/bfs/cover.png"), "https://i0.hdslb.com/bfs/cover.png");
  assert.throws(() => normalizeBiliMediaUrl("http://localhost/cover.png"));
});

test("web WBI signing uses the key permutation, sorted RFC3986 parameters and current timestamp", () => {
  const img = "7cd084941338484aae1ad9425b84077c", sub = "4932caff0ff746eab6f01bf08b70ac45";
  assert.equal(signWbi({ foo: 114, bar: 514, baz: 1919810 }, img, sub, 1702204169000),
    "bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee");
  const query = signWbi({ title: "甲 乙!'()*", wts: 1, w_rid: "old" }, img, sub, 2000);
  assert.match(query, /^title=%E7%94%B2%20%E4%B9%99&wts=2&w_rid=[a-f0-9]{32}$/);
  assert.throws(() => signWbi({}, "invalid", sub, 0));
});

test("danmaku contains inert text, sorts by video time and never expands external entities", () => {
  const value = parseDanmakuXml(`<i>
    <d p="2,1,25,65280,0,0,0,0">hello &amp; &lt;img onerror=alert(1)&gt;</d>
    <d p='1.5,5,25,16777215,0,0,0,0'>&#x4e2d;&#25991;</d>
    <d p="NaN,1,25,0">invalid</d><d p="4,8,25,0">script mode</d>
    <d p="3,4,25,-1"><![CDATA[plain <b>text</b>]]></d>
  </i>`);
  assert.deepEqual(value, [
    { time: 1.5, mode: 5, color: 16777215, text: "中文" },
    { time: 2, mode: 1, color: 65280, text: "hello & <img onerror=alert(1)>" },
    { time: 3, mode: 4, color: 16777215, text: "plain <b>text</b>" },
  ]);
  assert.throws(() => parseDanmakuXml('<!DOCTYPE i [<!ENTITY x SYSTEM "file:///secret">]><i/>'));
  assert.throws(() => parseDanmakuXml("x".repeat(8 * 1024 * 1024 + 1)));
});

test("permission, login and network errors use local messages without remote tokens", () => {
  assert.match(safeBiliError(-101), /重新扫码/);
  assert.match(safeBiliError(-403), /权限/);
  assert.match(safeBiliError(-404), /不存在/);
  assert.match(safeBiliError(-352), /限制/);
  for (const code of [-101, -403, -404, -352, 62002, 6002003, 99999]) {
    assert.doesNotMatch(safeBiliError(code), /https?:|SESSDATA|qrcode_key|deadline=/i);
  }
});
