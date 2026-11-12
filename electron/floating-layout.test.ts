import assert from "node:assert/strict";
import test from "node:test";
import { floatingBounds, validFloatingPosition } from "./floating-layout";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: -240, width: 1280, height: 984 };

test("floating window remains fully usable on a monitor with negative coordinates", () => {
  assert.deepEqual(floatingBounds({ x: -1220, y: -200 }, false, [primary, left]), {
    x: -1220, y: -200, width: 164, height: 44,
  });
  assert.deepEqual(floatingBounds({ x: -180, y: 730 }, true, [primary, left]), {
    x: -264, y: 596, width: 264, height: 148,
  });
});

test("a removed display brings the complete window into the nearest remaining work area", () => {
  assert.deepEqual(floatingBounds({ x: -1220, y: -200 }, true, [primary]), {
    x: 0, y: 0, width: 264, height: 148,
  });
  assert.deepEqual(floatingBounds({ x: 4900, y: 2300 }, false, [primary, left]), {
    x: 1756, y: 996, width: 164, height: 44,
  });
});

test("expanding near an edge does not mutate the remembered compact anchor", () => {
  const anchor = { x: 1700, y: 970 };
  const before = { ...anchor };
  assert.deepEqual(floatingBounds(anchor, true, [primary]), {
    x: 1656, y: 892, width: 264, height: 148,
  });
  assert.deepEqual(anchor, before);
  assert.deepEqual(floatingBounds(anchor, false, [primary]), {
    x: 1700, y: 970, width: 164, height: 44,
  });
});

test("default placement respects the primary display and taskbar work area", () => {
  assert.deepEqual(floatingBounds(undefined, false, [primary, left], 1), {
    x: -180, y: -224, width: 164, height: 44,
  });
});

test("media controls gain room without moving the remembered wage-only anchor", () => {
  const anchor = { x: 1740, y: 970 };
  const saved = { ...anchor };
  assert.deepEqual(floatingBounds(anchor, false, [primary], 0, true), {
    x: 1720, y: 970, width: 200, height: 44,
  });
  assert.deepEqual(floatingBounds(anchor, true, [primary], 0, true), {
    x: 1656, y: 892, width: 264, height: 148,
  });
  assert.deepEqual(anchor, saved);
  assert.deepEqual(floatingBounds(anchor, false, [primary], 0, false), {
    x: 1740, y: 970, width: 164, height: 44,
  });
});

test("media controls remain inside negative and small display work areas", () => {
  assert.deepEqual(floatingBounds({ x: -180, y: 700 }, false, [primary, left], 0, true), {
    x: -200, y: 700, width: 200, height: 44,
  });
  assert.deepEqual(floatingBounds(undefined, false, [{ x: 50, y: -100, width: 180, height: 40 }], 0, true), {
    x: 50, y: -100, width: 180, height: 40,
  });
});

test("small work areas clamp the window size as well as its position", () => {
  assert.deepEqual(floatingBounds({ x: 800, y: 600 }, true, [
    { x: 100, y: 200, width: 120, height: 90 },
  ]), { x: 100, y: 200, width: 120, height: 90 });
  assert.throws(() => floatingBounds(undefined, false, []), /没有可用/);
});

test("malformed saved positions cannot reach native window APIs", () => {
  for (const value of [null, undefined, true, "1,2", {}, [], { x: 1 },
    { x: "10", y: 10 }, { x: Infinity, y: 0 }, { x: NaN, y: 0 },
    { x: 0, y: -10_000_001 }])
    assert.equal(validFloatingPosition(value), false);
  assert.equal(validFloatingPosition({ x: -2000, y: 400.5 }), true);
});
