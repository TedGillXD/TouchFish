import assert from "node:assert/strict";
import { test } from "node:test";
import { HONGGUO_HOME, isHongguoNavigation, normalizeHongguoUrl } from "./hongguo-policy";

test("accepts official homepage and episode links for the Hongguo window", () => {
  assert.equal(normalizeHongguoUrl(undefined), undefined);
  assert.equal(normalizeHongguoUrl(" "), undefined);
  assert.equal(normalizeHongguoUrl(` ${HONGGUO_HOME} `), HONGGUO_HOME);
  const episode = "https://www.hongguoduanju.com/player/7706512650816982040/7706514815799282713";
  assert.equal(normalizeHongguoUrl(episode), episode);
  assert.ok(isHongguoNavigation(episode));
});

test("rejects protocol, credential, origin and port substitutions", () => {
  for (const url of [
    "http://hongguoduanju.com/", "javascript:alert(1)", "https://hongguoduanju.com.evil.example/",
    "https://x.hongguoduanju.com/", "https://hongguoduanju.com:444/", "https://user@hongguoduanju.com/",
    "https://hongguoduanju.com@evil.example/", "https://hongguoduanju.com/\nbad",
    "https://hongguoduanju.com\\other", "//hongguoduanju.com/",
  ]) {
    assert.throws(() => normalizeHongguoUrl(url));
    assert.equal(isHongguoNavigation(url), false);
  }
});

test("official terms and privacy links open only as exact in-window navigation", () => {
  const terms = "https://web.qznovel.com/wap-hongguo/dr-agreement-v2-ad.html";
  const privacy = "https://web.qznovel.com/wap-hongguo/dr-privacy-v3-ad.html";
  assert.ok(isHongguoNavigation(terms));
  assert.ok(isHongguoNavigation(privacy));
  assert.throws(() => normalizeHongguoUrl(terms));
  assert.equal(isHongguoNavigation(`${terms}?destination=evil.example`), false);
});
