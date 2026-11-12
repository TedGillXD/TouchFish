// Runs in an isolated world on www.youtube.com only. No page messages, cookies,
// media URLs, account fields, or credentials are read or passed to the app.
(() => {
  let managed = false, hold = false, intent = false, failed = false, video = null, timer = null, generation = -1;
  const id = () => { const u = new URL(location.href); const value = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1]; return /^[A-Za-z0-9_-]{11}$/.test(value ?? "") ? value : null; };
  const state = () => ({ videoId: id(), title: document.title.slice(0, 160), ready: !!video && video.readyState >= 1,
    playing: !!video && !video.paused && !video.ended, playIntent: intent && !hold && !video?.ended && !failed,
    buffering: intent && !hold && !!video && video.readyState < 3, ended: !!video?.ended, failed,
    currentTime: Number.isFinite(video?.currentTime) ? video.currentTime : 0, duration: Number.isFinite(video?.duration) ? video.duration : 0,
    volume: video?.volume ?? 1, playbackRate: video?.playbackRate ?? 1 });
  function pauseAll() { for (const element of document.querySelectorAll("video,audio")) element.pause(); }
  function report() { if (managed && id()) void chrome.runtime.sendMessage({ type: "touchfish-media", state: state() }).catch(() => {}); }
  function observe() {
    const next = document.querySelector("video.html5-main-video") ?? document.querySelector("video");
    if (next !== video) {
      video = next; failed = false; intent = !!video && !video.paused;
      if (video) {
        for (const name of ["play", "playing", "pause", "waiting", "canplay", "ended", "error", "loadedmetadata", "seeked"]) video.addEventListener(name, () => {
          if (hold && !video.paused) pauseAll();
          if (name === "play") intent = !hold;
          if (name === "pause" || name === "ended") intent = false;
          if (name === "error") { failed = true; intent = false; }
          report();
        });
      }
    }
    if (hold) pauseAll(); report();
  }
  function attach(suspended = false) {
    managed = true; hold = suspended;
    if (!timer) timer = setInterval(observe, 700);
    observe();
  }
  // Restored windows remain paused. A real user play gesture or an explicit
  // TouchFish command can resume; a website's automatic play cannot clear hold.
  document.addEventListener("click", event => { if (managed && event.isTrusted && event.target instanceof Element && event.target.closest(".ytp-play-button,video")) hold = false; }, true);
  document.addEventListener("keydown", event => { if (managed && event.isTrusted && [" ", "k", "K"].includes(event.key)) hold = false; }, true);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "touchfish-control") return false;
    // A delayed attach/play from before the boss key must never clear its hold.
    if (!Number.isSafeInteger(message.generation) || message.generation < generation) { respond(state()); return false; }
    generation = message.generation;
    if (message.action === "attach") { attach(false); respond({ ...state(), sourceId: null }); return false; }
    if (message.action === "hold") { attach(true); intent = false; pauseAll(); report(); respond(state()); return false; }
    if (!managed) { respond({ ready: false, failed: true }); return false; }
    observe();
    if (message.action === "setPlaying" && typeof message.playing === "boolean") {
      hold = false; intent = message.playing; failed = false;
      if (!intent) pauseAll();
      else if (video) { if (video.ended) video.currentTime = 0; void video.play().catch(() => { failed = true; intent = false; report(); }); }
    } else if (message.action === "setVolume" && Number.isFinite(message.volume) && message.volume >= 0 && message.volume <= 1 && video) video.volume = message.volume;
    else if (message.action === "setPlaybackRate" && Number.isFinite(message.rate) && message.rate >= .25 && message.rate <= 4 && video) video.playbackRate = message.rate;
    report(); respond(state()); return false;
  });
  void chrome.runtime.sendMessage({ type: "touchfish-hello" }).then(result => {
    if (result?.managed && generation === -1 && Number.isSafeInteger(result.generation)) {
      generation = result.generation; attach(result.suspended);
    }
  }).catch(() => {});
})();
