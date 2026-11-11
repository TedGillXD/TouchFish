# Bilibili player test media

These files are original synthetic fixtures, not downloaded Bilibili content.
They are used only by isolated Electron integration tests and are excluded from
the packaged application.

- `bili-video.webm`: a small VP8 canvas animation recorded with Chromium
  MediaRecorder. Its WebM timecode scale and duration metadata are adjusted to
  provide a seekable, roughly twenty-second track.
- `bili-audio.wav`: twenty seconds of quiet, generated PCM audio (8 kHz, mono,
  8-bit). The WAV container allows deterministic range and seeking tests.

The actual Bilibili AVC/AAC DASH format is separately checked against public
playback endpoints; these fixtures exercise playback, synchronization, range
requests, controls and window behavior without depending on the public service.
