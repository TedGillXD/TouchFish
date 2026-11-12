import assert from "node:assert/strict";
import test from "node:test";
import { isBridgeHost, isYouTubeExtensionOrigin, normalizeYouTubeVideo, YOUTUBE_EXTENSION_ORIGIN } from "./youtube-policy";

test("YouTube inputs canonicalize public watch/short/live links without forwarding arbitrary destinations", () => {
  for (const input of ["aqz-KE-bpKQ", "https://youtu.be/aqz-KE-bpKQ?t=4", "https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=ignored", "https://www.youtube.com/shorts/aqz-KE-bpKQ", "https://m.youtube.com/live/aqz-KE-bpKQ"])
    assert.deepEqual(normalizeYouTubeVideo(input), { videoId: "aqz-KE-bpKQ", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" });
  for (const input of ["http://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://youtube.com.evil.example/watch?v=aqz-KE-bpKQ", "https://user:password@www.youtube.com/watch?v=aqz-KE-bpKQ", "https://www.youtube.com:8443/watch?v=aqz-KE-bpKQ", "https://127.0.0.1/aqz-KE-bpKQ", "https://www.youtube.com/redirect?q=https://evil.example", "aqz-KE", null])
    assert.throws(() => normalizeYouTubeVideo(input));
});

test("the bridge accepts only the fixed companion extension and its literal loopback host", () => {
  assert.equal(isYouTubeExtensionOrigin(YOUTUBE_EXTENSION_ORIGIN), true);
  for (const origin of [undefined, "null", "https://www.youtube.com", `${YOUTUBE_EXTENSION_ORIGIN}.evil`, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
    assert.equal(isYouTubeExtensionOrigin(origin), false);
  assert.equal(isBridgeHost("127.0.0.1:4555", 4555), true);
  for (const host of ["localhost:4555", "127.0.0.1.evil:4555", "evil.example:4555", "127.0.0.1:4556", undefined])
    assert.equal(isBridgeHost(host, 4555), false);
});
