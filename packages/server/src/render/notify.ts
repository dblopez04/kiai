// Discord notifications when a render finishes or fails. A DM needs a bot that shares a server
// with you (webhooks can't DM); a webhook into a private channel needs no bot. The message links
// the public replay page, whose og:video tags make Discord play the video inline.

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

const RANK_COLORS: Record<string, number> = { X: 0xffd54a, XH: 0xd9d9d9, S: 0xffab40, SH: 0xc0c0c0, A: 0x6ee39a, B: 0x7fb0ff, C: 0xc79bff, D: 0xff8a8a };
const RANK_LABEL: Record<string, string> = { X: "SS", XH: "SS", SH: "S" };

export function replayTitle(r: ReplayView): string {
  const b = r.beatmap;
  if (!b?.title) return `Beatmap ${r.beatmap_md5.slice(0, 8)}`;
  return `${b.artist ?? "Unknown artist"} - ${b.title}${b.version ? ` [${b.version}]` : ""}`;
}

export const publicReplayUrl = (publicUrl: string, id: string) => `${publicUrl}/r/${id}`;

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

export function renderedMessage(r: ReplayView, publicUrl: string | undefined) {
  const link = publicUrl ? publicReplayUrl(publicUrl, r.id) : undefined;
  const a = r.attributes;
  const fields = [
    ...(a ? [{ name: "Map", value: `${a.stars.toFixed(2)}★ · AR ${a.ar} · OD ${a.od} · CS ${a.cs} · ${Math.round(a.bpm)} BPM`, inline: false }] : []),
    { name: "Player", value: r.player_name || "?", inline: true },
    { name: "Server", value: r.devserver ?? "osu!", inline: true },
    ...(r.render?.preset ? [{ name: "Preset", value: r.render.preset, inline: true }] : []),
  ];
  return {
    // The bare link is what Discord unfurls into a playable video.
    content: link ?? "Rendered. Set PUBLIC_URL on the server to get a link here.",
    embeds: [
      {
        title: replayTitle(r).slice(0, 256),
        ...(link ? { url: link } : {}),
        description: playSummary(r),
        color: RANK_COLORS[r.rank] ?? 0xff66aa,
        ...(r.beatmap?.cover_url ? { thumbnail: { url: r.beatmap.cover_url } } : {}),
        fields,
        timestamp: r.played_at,
        footer: { text: "kiai" },
      },
    ],
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
      await post(`${options.webhookUrl}?wait=true`, message, false);
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
