// Discord notifications when a render finishes or fails. A DM needs a bot that shares a server
// with you (webhooks can't DM); a webhook into a private channel needs no bot. Videos are never
// uploaded to Discord: the message's media gallery points at the public video URL, and Discord
// streams it from there.

import { errorMessage } from "../errors.ts";
import type { ReplayView } from "../replays/store.ts";
import { modLabel } from "../scores/mods.ts";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/dblopez04/kiai, 0.1)";

export interface Notifier {
  rendered(replay: ReplayView): Promise<void>;
  failed(replay: ReplayView, error: string): Promise<void>;
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

/** Versioned by render, so a re-render isn't served from a cache. */
export const publicVideoUrl = (publicUrl: string, r: ReplayView) => `${publicReplayUrl(publicUrl, r.id)}/video.mp4?v=${r.render?.id ?? 0}`;

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

/** Discord markdown in names and titles shouldn't format the message. */
export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|>]/g, "\\$&");

/** Link text also needs its brackets escaped, which diff names nearly always have. */
const escapeLinkText = (text: string) => escapeMarkdown(text).replace(/[[\]]/g, "\\$&");

// Components V2: https://discord.com/developers/docs/components/reference
const IS_COMPONENTS_V2 = 1 << 15;
const CONTAINER = 17;
const TEXT_DISPLAY = 10;
const MEDIA_GALLERY = 12;
const ACCENT_COLOR = 0xff66aa;

/**
 * The message for a finished render: a container with three short lines (map, play, and the
 * map's stats in small text) over the video, so the video takes most of the space. A bare link
 * would unfurl into an embed that repeats the title and summary above the video.
 */
export function renderedMessage(r: ReplayView, publicUrl: string | undefined) {
  const a = r.attributes;
  const title = publicUrl ? `[${escapeLinkText(replayTitle(r))}](${publicReplayUrl(publicUrl, r.id)})` : escapeMarkdown(replayTitle(r));
  const lines = [
    `**${title}**`,
    escapeMarkdown(`${playSummary(r)} · ${r.player_name || "?"}${r.devserver ? ` on ${r.devserver}` : ""}`),
    ...(a ? [`-# ${a.stars.toFixed(2)}★ · AR ${a.ar} · OD ${a.od} · CS ${a.cs} · ${Math.round(a.bpm)} BPM`] : []),
    ...(publicUrl ? [] : ["-# Rendered. Set PUBLIC_URL on the server to get the video here."]),
  ];
  const video = publicUrl ? [{ type: MEDIA_GALLERY, items: [{ media: { url: publicVideoUrl(publicUrl, r) } }] }] : [];
  return {
    flags: IS_COMPONENTS_V2,
    components: [{ type: CONTAINER, accent_color: ACCENT_COLOR, components: [{ type: TEXT_DISPLAY, content: lines.join("\n") }, ...video] }],
    allowed_mentions: { parse: [] },
  };
}

export function failedMessage(r: ReplayView, error: string) {
  return {
    content: `Render failed: **${replayTitle(r)}** (replay ${r.id})\n\`\`\`\n${error.slice(0, 1500)}\n\`\`\``,
    allowed_mentions: { parse: [] },
  };
}

/** Null when neither a bot DM nor a webhook is configured. */
export function discordNotifier(options: DiscordOptions): Notifier | null {
  const doFetch = options.fetch ?? fetch;
  const useBot = Boolean(options.botToken && options.userId);
  if (!useBot && !options.webhookUrl) return null;
  let dmChannel: string | null = null;

  async function post(url: string, body: unknown, bot: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, ...(bot ? { Authorization: `Bot ${options.botToken}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 && attempt < 2) {
        const retry = Number(((await response.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
        await new Promise((resolve) => setTimeout(resolve, Math.min(retry, 30) * 1000));
        continue;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      return response;
    }
  }

  async function send(message: unknown): Promise<void> {
    if (useBot) {
      if (!dmChannel) {
        const channel = (await (await post(`${API}/users/@me/channels`, { recipient_id: options.userId }, true)).json()) as { id: string };
        dmChannel = channel.id;
      }
      await post(`${API}/channels/${dmChannel}/messages`, message, true);
    } else {
      // Webhooks drop components unless asked; display-only ones work on any webhook.
      await post(`${options.webhookUrl}?wait=true&with_components=true`, message, false);
    }
  }

  return {
    rendered: (replay) => send(renderedMessage(replay, options.publicUrl)),
    failed: (replay, error) => send(failedMessage(replay, error)),
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
