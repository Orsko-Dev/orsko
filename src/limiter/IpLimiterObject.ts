import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { nowMs } from "../util/time";

const KEY = "hits";

export class IpLimiterObject extends DurableObject<Env> {
  async hit(input: {
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = nowMs();
    const windowMs = input.windowSeconds * 1000;
    const stored = (await this.ctx.storage.get<number[]>(KEY)) ?? [];
    const recent = stored.filter((t) => now - t < windowMs);
    if (recent.length >= input.limit) {
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      await this.ctx.storage.put(KEY, recent);
      return { allowed: false, retryAfterSeconds };
    }
    const next = [...recent, now];
    await this.ctx.storage.put(KEY, next);
    await this.ctx.storage.setAlarm(now + windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
