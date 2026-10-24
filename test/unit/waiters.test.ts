import { describe, expect, it, vi } from "vitest";
import { WaiterRegistry } from "../../src/room/waiters";

describe("WaiterRegistry", () => {
  it("wakes all waiters and clears them", () => {
    const reg = new WaiterRegistry();
    const woke: number[] = [];
    reg.add(1, () => woke.push(1));
    reg.add(2, () => woke.push(2));
    expect(reg.count()).toBe(2);
    reg.wakeAll();
    expect(woke).toEqual([1, 2]);
    expect(reg.count()).toBe(0);
  });

  it("returned remover drops one waiter without waking it", () => {
    const reg = new WaiterRegistry();
    let fired = false;
    const remove = reg.add(0, () => {
      fired = true;
    });
    remove();
    expect(reg.count()).toBe(0);
    reg.wakeAll();
    expect(fired).toBe(false);
  });

  it("clears the caller's timer when woken early, mirroring RoomObject.waitForMessage", async () => {
    // This reproduces the exact resolve-wrapping pattern used in
    // RoomObject.waitForMessage: the caller owns a setTimeout id and the
    // registry's resolve callback is responsible for clearing it when the
    // waiter is woken by wakeAll() instead of by the timeout firing. A real
    // (long) timer is used and cleared immediately, so this test does not
    // depend on fake timers and does not actually wait 5 seconds.
    const reg = new WaiterRegistry();
    const clearSpy = vi.spyOn(global, "clearTimeout");
    try {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const remove = reg.add(0, () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        });
        timer = setTimeout(() => {
          remove();
          resolve();
        }, 5000);
        reg.wakeAll();
      });
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });
});
