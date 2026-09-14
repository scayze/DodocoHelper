import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bindTimerPill, createRunTimer } from "../src/leaderboard/report.js";
import { formatClock } from "../src/leaderboard/api.js";

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe("run timer pause/resume", () => {
  it("counts only actively viewed spans", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.start();
    clock.advance(5_000);
    timer.pause();
    // Hidden/tabbed away: must not count.
    clock.advance(60_000);
    timer.resume();
    clock.advance(3_000);
    assert.equal(timer.elapsed(), 8_000);
  });

  it("freezes while paused and resumes from the banked value", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.start();
    clock.advance(2_000);
    timer.pause();
    assert.equal(timer.elapsed(), 2_000);
    clock.advance(10_000);
    assert.equal(timer.elapsed(), 2_000);
    timer.resume();
    clock.advance(1_000);
    assert.equal(timer.elapsed(), 3_000);
  });

  it("ignores pause/resume when idle, doubled, or finished", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    assert.equal(timer.elapsed(), 0);
    timer.pause();
    timer.resume();
    assert.equal(timer.elapsed(), 0);
    timer.start();
    clock.advance(1_000);
    timer.pause();
    timer.pause();
    clock.advance(5_000);
    assert.equal(timer.elapsed(), 1_000);
    timer.resume();
    timer.resume();
    clock.advance(1_000);
    assert.equal(timer.elapsed(), 2_000);
    timer.stop();
    clock.advance(9_000);
    assert.equal(timer.elapsed(), 2_000);
    // A finished game never resumes.
    timer.resume();
    clock.advance(4_000);
    assert.equal(timer.elapsed(), 2_000);
  });

  it("restarts cleanly and reports at least 1ms once live", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.start();
    assert.equal(timer.elapsed(), 1);
    clock.advance(100);
    timer.stop();
    assert.equal(timer.elapsed(), 100);
    timer.start();
    assert.equal(timer.elapsed(), 1);
  });
});

describe("run timer restore from persisted state", () => {
  it("restores a run banked and paused until the next resume", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.restoreElapsed(30_000);
    assert.equal(timer.elapsed(), 30_000);
    // Not actively viewed yet: time must not count until resume.
    clock.advance(60_000);
    assert.equal(timer.elapsed(), 30_000);
    timer.resume();
    clock.advance(5_000);
    assert.equal(timer.elapsed(), 35_000);
  });

  it("stop() banks a restored value for finished boards, which never resume", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.restoreElapsed(9_000);
    timer.stop();
    clock.advance(99_000);
    assert.equal(timer.elapsed(), 9_000);
    timer.resume();
    clock.advance(1_000);
    assert.equal(timer.elapsed(), 9_000);
  });

  it("start() resets a restored timer; a zero restore still reports at least 1ms", () => {
    const clock = fakeClock();
    const timer = createRunTimer(clock.now);
    timer.restoreElapsed(40_000);
    timer.start();
    assert.equal(timer.elapsed(), 1);
    clock.advance(250);
    assert.equal(timer.elapsed(), 250);
    const fresh = createRunTimer(clock.now);
    fresh.restoreElapsed(0);
    assert.equal(fresh.elapsed(), 1);
  });
});

describe("timer pill binding", () => {
  it("silences the previous timer when another binds to the same pill", () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g["window"];
    const prevDocument = g["document"];
    let nextId = 1;
    const live = new Map<number, () => void>();
    const node = { textContent: "" };
    g["window"] = {
      setInterval: (cb: () => void): number => {
        const id = nextId++;
        live.set(id, cb);
        return id;
      },
      clearInterval: (id: number): void => {
        live.delete(id);
      },
    };
    g["document"] = { getElementById: () => node };
    try {
      const clockA = fakeClock();
      const clockB = fakeClock();
      const daily = createRunTimer(clockA.now);
      const endless = createRunTimer(clockB.now);
      daily.start();
      clockA.advance(30_000);
      bindTimerPill(daily, "mines-timer-value", formatClock);
      assert.equal(live.size, 1);
      // Switching boards: the paused daily interval must not keep writing.
      daily.pause();
      endless.start();
      bindTimerPill(endless, "mines-timer-value", formatClock);
      assert.equal(live.size, 1);
      clockB.advance(61_000);
      for (const cb of live.values()) cb();
      assert.equal(node.textContent, "1:01");
      // Unticking never touches elapsed time.
      assert.equal(daily.elapsed(), 30_000);
    } finally {
      if (prevWindow === undefined) delete g["window"];
      else g["window"] = prevWindow;
      if (prevDocument === undefined) delete g["document"];
      else g["document"] = prevDocument;
    }
  });
});
