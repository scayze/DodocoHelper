import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRunTimer } from "../src/leaderboard/report.js";

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
