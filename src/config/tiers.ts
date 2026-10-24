export type Tier = "free" | "paid";

export interface TierLimits {
  readonly liveWindowSecondsPerDay: number | null;
  readonly idleToSlowSeconds: number;
  readonly idleToArchiveSeconds: number;
  readonly archiveRetentionDays: number;
  readonly maxMessages: number;
  readonly maxMessageTextBytes: number;
  readonly maxAttachmentBytes: number;
  readonly maxAttachmentsPerRoom: number;
  readonly maxMembers: number;
  readonly maxPostsPerMinutePerMember: number;
}

const MiB = 1024 * 1024;

export const TIERS: Readonly<Record<Tier, TierLimits>> = {
  free: {
    liveWindowSecondsPerDay: 6 * 3600,
    idleToSlowSeconds: 30 * 60,
    idleToArchiveSeconds: 24 * 3600,
    archiveRetentionDays: 7,
    maxMessages: 2000,
    maxMessageTextBytes: 32 * 1024,
    maxAttachmentBytes: 10 * MiB,
    maxAttachmentsPerRoom: 50,
    maxMembers: 8,
    maxPostsPerMinutePerMember: 60,
  },
  paid: {
    liveWindowSecondsPerDay: null,
    idleToSlowSeconds: 30 * 60,
    idleToArchiveSeconds: 24 * 3600,
    archiveRetentionDays: 90,
    maxMessages: 20000,
    maxMessageTextBytes: 32 * 1024,
    maxAttachmentBytes: 100 * MiB,
    maxAttachmentsPerRoom: 500,
    maxMembers: 50,
    maxPostsPerMinutePerMember: 60,
  },
} as const;

export function isTier(name: string): name is Tier {
  return name === "free" || name === "paid";
}

export function getTier(name: string): TierLimits {
  if (!isTier(name)) throw new Error(`Unknown tier: ${name}`);
  return TIERS[name];
}
