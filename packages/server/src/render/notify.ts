// Discord notifications when a render or clip finishes or fails. A DM needs a bot that shares a
// server with you (webhooks can't DM); a webhook into a private channel needs no bot. Videos are
// never uploaded to Discord: the message's media gallery points at the public video URL, and
// Discord streams it from there.

import { formatTimestamp, type Clip } from "../clips/store.ts";
import { API, DiscordError, discordRequest } from "../discord/rest.ts";
import { errorMessage } from "../errors.ts";
import type { ReplayView } from "../replays/store.ts";
import { modLabel } from "../scores/mods.ts";

export interface Notifier {
  rendered(replay: ReplayView): Promise<void>;
  failed(replay: ReplayView, error: string): Promise<void>;
  /** A finished or failed clip: edits the /clip reply while its token lasts, else sends a new message. */
  clip(replay: ReplayView, clip: Clip): Promise<void>;
}

export interface DiscordOptions {
  botToken?: string | undefined;
  userId?: string | undefined;
  webhookUrl?: string | undefined;
  /** Links point here; without it the message has no link and Discord can't show the video. */
  publicUrl?: string | undefined;
  fetch?: typeof fetch;
}

const RANK_LABEL: Record<string, string> = { X: "SS", XH: "SS", SH: "S" };

export function replayTitle(r: ReplayView): string {
  const b = r.beatmap;
  if (!b?.title) return `Beatmap ${r.beatmap_md5.slice(0, 8)}`;
  return `${b.artist ?? "Unknown artist"} - ${b.title}${b.version ? ` [${b.version}]` : ""}`;
}

export const publicReplayUrl = (publicUrl: string, id: string) => `${publicUrl}/r/${id}`;

/**
 * The video for Discord and link previews: a copy small enough for Discord to play, when the
 * render is too big. Versioned by render, so a re-render isn't served from a cache.
 */
export const publicEmbedUrl = (publicUrl: string, r: ReplayView) => `${publicReplayUrl(publicUrl, r.id)}/embed.mp4?v=${r.render?.id ?? 0}`;

export const publicClipUrl = (publicUrl: string, id: string) => `${publicUrl}/c/${id}/video.mp4`;

/** The pp shown for a play: osu!'s when the play is in the score library, else rosu-pp's estimate. */
export function displayPp(r: ReplayView): { pp: number; estimate: boolean } | null {
  if (r.score_pp !== null) return { pp: r.score_pp, estimate: false };
  if (r.attributes) return { pp: r.attributes.pp, estimate: true };
  return null;
}

/** One line such as `S · 98.12% · 512x · 312pp · HD DT`. */
export function playSummary(r: ReplayView): string {
  const pp = displayPp(r);
  const parts = [
    RANK_LABEL[r.rank] ?? r.rank,
    `${(r.accuracy * 100).toFixed(2)}%`,
    `${r.max_combo}x${r.countmiss ? ` · ${r.countmiss}❌` : r.perfect ? " FC" : ""}`,
    ...(pp ? [`${Math.round(pp.pp)}pp${pp.estimate ? "*" : ""}`] : []),
    r.mods.length ? r.mods.map(modLabel).join(" ") : "NM",
  ];
  return parts.join(" · ");
}

/** `5.12★ · AR 9 · OD 8 · CS 4 · 180 BPM`, once the render worker has worked the map out. */
export function mapStats(r: ReplayView): string | null {
  const a = r.attributes;
  return a ? `${a.stars.toFixed(2)}★ · AR ${a.ar} · OD ${a.od} · CS ${a.cs} · ${Math.round(a.bpm)} BPM` : null;
}

export const clipRange = (clip: Pick<Clip, "start_ms" | "end_ms">) => `${formatTimestamp(clip.start_ms)}–${formatTimestamp(clip.end_ms)}`;

/** Discord markdown in names and titles shouldn't format the message. */
export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|>]/g, "\\$&");

/** Link text also needs its brackets escaped, which diff names nearly always have. */
const escapeLinkText = (text: string) => escapeMarkdown(text).replace(/[[\]]/g, "\\$&");

// Components V2: https://discord.com/developers/docs/components/reference
export const IS_COMPONENTS_V2 = 1 << 15;
const CONTAINER = 17;
const TEXT_DISPLAY = 10;
const MEDIA_GALLERY = 12;
const ACCENT_COLOR = 0xff66aa;
/** Interaction tokens last 15 minutes; after that a clip goes out as a new DM or webhook message. */
const INTERACTION_TOKEN_MS = 14 * 60_000;

/**
 * A play's card: the map (linked to its public page), the play, then `notes` in small text, all
 * over the video, so the video takes most of the space. A bare link would unfurl into an embed
 * that repeats the title and summary above the video.
 */
export function replayCard(r: ReplayView, publicUrl: string | undefined, notes: readonly string[], videoUrl: string | null) {
  const title = publicUrl ? `[${escapeLinkText(replayTitle(r))}](${publicReplayUrl(publicUrl, r.id)})` : escapeMarkdown(replayTitle(r));
  const lines = [
    `**${title}**`,
    escapeMarkdown(`${playSummary(r)} · ${r.player_name || "?"}${r.devserver ? ` on ${r.devserver}` : ""}`),
    ...notes.map((note) => `-# ${note}`),
  ];
  const video = videoUrl ? [{ type: MEDIA_GALLERY, items: [{ media: { url: videoUrl } }] }] : [];
  return [{ type: CONTAINER, accent_color: ACCENT_COLOR, components: [{ type: TEXT_DISPLAY, content: lines.join("\n") }, ...video] }];
}

const cardMessage = (components: ReturnType<typeof replayCard>) => ({ flags: IS_COMPONENTS_V2, components, allowed_mentions: { parse: [] } });

/** The message for a finished render: the play's card over its video. */
export function renderedMessage(r: ReplayView, publicUrl: string | undefined) {
  const notes = [mapStats(r), publicUrl ? null : "Rendered. Set PUBLIC_URL on the server to get the video here."].filter((note) => note !== null);
  return cardMessage(replayCard(r, publicUrl, notes, publicUrl ? publicEmbedUrl(publicUrl, r) : null));
}

export function failedMessage(r: ReplayView, error: string) {
  return {
    content: `Render failed: **${replayTitle(r)}** (replay ${r.id})\n\`\`\`\n${error.slice(0, 1500)}\n\`\`\``,
    allowed_mentions: { parse: [] },
  };
}

/** The reply to /clip while the clip is cut (after rendering the replay, if it had no render). */
export function clipPendingMessage(r: ReplayView, clip: Clip, publicUrl: string | undefined, rendering: boolean) {
  const doing = rendering ? "rendering the replay first, then clipping" : "clipping";
  return cardMessage(replayCard(r, publicUrl, [`✂️ ${clipRange(clip)} · ${doing}…`], null));
}

/** A finished clip, the card over the clip; or why there's no clip. */
export function clipMessage(r: ReplayView, clip: Clip, publicUrl: string | undefined) {
  if (clip.status !== "success" || !publicUrl) {
    const error = clip.status === "success" ? "set PUBLIC_URL on the server to watch clips." : (clip.error_text ?? "it failed.");
    return cardMessage(replayCard(r, publicUrl, [`✂️ ${clipRange(clip)} · no clip: ${escapeMarkdown(error.slice(0, 500))}`], null));
  }
  const stats = mapStats(r);
  return cardMessage(replayCard(r, publicUrl, [`✂️ ${clipRange(clip)}${stats ? ` · ${stats}` : ""}`], publicClipUrl(publicUrl, clip.id)));
}

/** Null when neither a bot DM nor a webhook is configured. */
export function discordNotifier(options: DiscordOptions): Notifier | null {
  const useBot = Boolean(options.botToken && options.userId);
  if (!useBot && !options.webhookUrl) return null;
  const request = (url: string, body: unknown, bot: boolean, method: "POST" | "PATCH" = "POST") =>
    discordRequest(url, { method, body, botToken: bot ? options.botToken : undefined, ...(options.fetch ? { fetch: options.fetch } : {}) });
  let dmChannel: string | null = null;

  async function send(message: unknown): Promise<void> {
    if (useBot) {
      if (!dmChannel) {
        const channel = (await (await request(`${API}/users/@me/channels`, { recipient_id: options.userId }, true)).json()) as { id: string };
        dmChannel = channel.id;
      }
      await request(`${API}/channels/${dmChannel}/messages`, message, true);
    } else {
      // Webhooks drop components unless asked; display-only ones work on any webhook.
      await request(`${options.webhookUrl}?wait=true&with_components=true`, message, false);
    }
  }

  return {
    rendered: (replay) => send(renderedMessage(replay, options.publicUrl)),
    failed: (replay, error) => send(failedMessage(replay, error)),
    async clip(replay, clip) {
      const message = clipMessage(replay, clip, options.publicUrl);
      const d = clip.discord;
      if (d && Date.now() - new Date(clip.created_at).getTime() < INTERACTION_TOKEN_MS) {
        try {
          // Turn the "clipping…" reply into the clip.
          await request(`${API}/webhooks/${d.application_id}/${d.token}/messages/@original`, { components: message.components }, false, "PATCH");
          return;
        } catch (error) {
          // The reply was deleted or its token expired: send the clip as a new message.
          if (!(error instanceof DiscordError) || error.status !== 404) throw error;
        }
      }
      await send(message);
    },
  };
}

/** Never let a notification problem fail a render. */
export async function notifySafely(action: () => Promise<void>, log: (message: string) => void): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    log(`Discord notification failed: ${errorMessage(error)}`);
    return false;
  }
}
