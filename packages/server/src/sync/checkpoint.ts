import { z } from "zod";

export const SYNC_MODES = ["recent", "history", "refresh", "reset"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];
export type SyncTrigger = "manual" | "schedule" | "api";
export type SyncStatus = "queued" | "running" | "success" | "failed";

/**
 * Progress saved as a job runs. A failed history import, PP refresh or reset is re-queued with
 * its last checkpoint, so it resumes instead of starting over.
 */
export const checkpointSchema = z
  .object({
    phase: z.enum(["played-list", "recent", "scores", "refresh", "export"]).optional(),
    // History import: the profile's most-played list, paged by offset.
    playedListOffset: z.number().int().nonnegative().optional(),
    /** Ids on the last committed page; the same page twice means osu! stopped advancing. */
    playedListLastPage: z.string().optional(),
    playedListComplete: z.boolean().optional(),
    // History import: per-map score checks, in beatmap id order.
    lastBeatmapId: z.number().int().nonnegative().optional(),
    mapsProcessed: z.number().int().nonnegative().optional(),
    mapsTotal: z.number().int().nonnegative().optional(),
    /** When recent plays were last fetched; long imports re-fetch them every 15 minutes. */
    lastRecentAt: z.string().optional(),
    // PP refresh.
    lastRefreshedScoreId: z.number().int().nonnegative().optional(),
    scoresRefreshed: z.number().int().nonnegative().optional(),
    scoresTotal: z.number().int().nonnegative().optional(),
    ppUnavailable: z.number().int().nonnegative().optional(),
    /** Reset: the library was archived and cleared; never do it twice for one job. */
    resetComplete: z.boolean().optional(),
  })
  .loose();

export type SyncCheckpoint = z.infer<typeof checkpointSchema>;

export function parseCheckpoint(value: unknown): SyncCheckpoint {
  const parsed = checkpointSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
