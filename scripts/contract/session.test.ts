import { afterEach, describe, expect, it } from "vitest";
import { ContractSession } from "./session";
import { closeServers, startServer, wallClock } from "./testSupport";

/**
 * The connection of the contract runner by itself: what its waits measure their time with.
 */

afterEach(closeServers);

describe("the clock of the runner", () => {
  it("a wait lasts as long as it says, whatever is done to the wall clock while it lasts", async () => {
    const { url, mock } = await startServer(undefined, { startPaused: true });
    const machine = mock as unknown as { enterStop(reason: string): void };
    const session = new ContractSession(url, { timeoutFactor: 1, clientName: "the test of the clock" });
    await session.open();
    try {
      const clock = wallClock();
      // Set ten seconds ahead 100 ms into a wait of two seconds: the tick that comes at 600 ms is in time.
      let mark = session.mark();
      let started = performance.now();
      setTimeout(() => {
        clock.ahead = 10_000;
      }, 100);
      setTimeout(() => machine.enterStop("pause"), 600);
      const stop = await session.waitForTick((tick) => tick.executionState.stopId === 2, 2000, "the tick of a stop that is 600 ms away", mark);
      expect(stop.tick.executionState).toEqual({ state: "paused", stopId: 2, reason: "pause" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(500);

      // Set back by those ten seconds 100 ms into a wait of 400 ms: the wait is over at 400 ms,
      // for a tick and for a binary frame.
      for (const wait of [
        () => session.waitForTick(() => false, 400, "a tick that does not come", mark).then(() => "a tick", (error: Error) => error.message),
        () => session.waitForBinary(0, 400).then((frame) => (frame ? "a frame" : "no binary frame")),
      ]) {
        clock.ahead = 10_000;
        mark = session.mark();
        started = performance.now();
        setTimeout(() => {
          clock.ahead = 0;
        }, 100);
        expect(await wait()).toMatch(/^a tick that does not come: not seen within 400 ms; ticks since then: 0$|^no binary frame$/);
        expect(performance.now() - started).toBeGreaterThanOrEqual(390);
        expect(performance.now() - started).toBeLessThan(2000);
      }
    } finally {
      session.close();
    }
  }, 30_000);
});
