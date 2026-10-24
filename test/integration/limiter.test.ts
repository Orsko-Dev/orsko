import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("IpLimiterObject", () => {
  it("allows up to limit then blocks with retry", async () => {
    const stub = env.IP_LIMITER.getByName(`test-${Math.random()}`);
    for (let i = 0; i < 3; i += 1) {
      expect((await stub.hit({ limit: 3, windowSeconds: 60 })).allowed).toBe(true);
    }
    const blocked = await stub.hit({ limit: 3, windowSeconds: 60 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("alarm clears stored hits so the window resets", async () => {
    const stub = env.IP_LIMITER.getByName(`test-alarm-${Math.random()}`);
    await stub.hit({ limit: 1, windowSeconds: 60 });
    expect((await stub.hit({ limit: 1, windowSeconds: 60 })).allowed).toBe(false);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.hit({ limit: 1, windowSeconds: 60 })).allowed).toBe(true);
  });
});
