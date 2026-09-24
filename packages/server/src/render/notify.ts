// Discord notifications when a render finishes or fails. A DM needs a bot that shares a server
// with you (webhooks can't DM); a webhook into a private channel needs no bot. A small video is
// uploaded with the message and plays in Discord as it is; a larger one is linked, and the public
// replay page's video tags make Discord play it inline.

import fs from "node:fs";
import { errorMessage } from "../errors.ts";
import type { ReplayView } from "../replays/store.ts";
import { modLabel } from "../scores/mods.ts";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/dblopez04/kiai, 0.1)";

export interface RenderedVideo {
  file: string;
  bytes: number;
}

export interface Notifier {
  rendered(replay: ReplayView, video: RenderedVideo): Promise<void>;
  failed(replay: ReplayView, error: string): Promise<void>;
}

export interface DiscordOptions {
  botToken?: string | undefined;
  userId?: string | undefined;
  webhookUrl?: string | undefined;
  /** Links point here; without it only an uploaded video can play in Discord. */
  publicUrl?: string | undefined;
  /** Upload videos up to this many bytes with the message. 0 never uploads. */
  attachMaxBytes?: number;
  fetch?: typeof fetch;
}

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

/** Discord markdown in names and titles shouldn't format the message. */
export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|>]/g, "\\$&");

/**
 * The message for a finished render: text only, with no embed of its own, because Discord
 * doesn't unfurl links in a message that already has one. The link's page then shows as the
 * playable video. When the video itself is attached, the link is wrapped in <> so it doesn't
 * unfurl into a second copy.
 */
export function renderedMessage(r: ReplayView, publicUrl: string | undefined, options: { attached?: boolean } = {}) {
  const link = publicUrl ? publicReplayUrl(publicUrl, r.id) : undefined;
  const a = r.attributes;
  const lines = [
    `**${escapeMarkdown(replayTitle(r))}**`,
    escapeMarkdown(`${playSummary(r)} · ${r.player_name || "?"}${r.devserver ? ` on ${r.devserver}` : ""}`),
    ...(a ? [`${a.stars.toFixed(2)}★ · AR ${a.ar} · OD ${a.od} · CS ${a.cs} · ${Math.round(a.bpm)} BPM`] : []),
    link
      ? options.attached ? `<${link}>` : link
      : options.attached ? "" : "Set PUBLIC_URL on the server (or keep videos under DISCORD_ATTACH_MAX_MB) to watch it here.",
  ];
  return { content: lines.filter(Boolean).join("\n"), allowed_mentions: { parse: [] } };
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
    const multipart = body instanceof FormData;
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          // fetch sets the multipart boundary itself.
          ...(multipart ? {} : { "Content-Type": "application/json" }),
          "User-Agent": USER_AGENT,
          ...(bot ? { Authorization: `Bot ${options.botToken}` } : {}),
        },
        body: multipart ? body : JSON.stringify(body),
        // Uploads get longer.
        signal: AbortSignal.timeout(multipart ? 120_000 : 20_000),
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

  async function send(message: object | FormData): Promise<void> {
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

  async function rendered(replay: ReplayView, video: RenderedVideo): Promise<void> {
    const attachMax = options.attachMaxBytes ?? 0;
    if (video.bytes > 0 && video.bytes <= attachMax) {
      const message = renderedMessage(replay, options.publicUrl, { attached: true });
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ ...message, attachments: [{ id: 0, filename: `${replay.id}.mp4` }] }));
      form.set("files[0]", await fs.openAsBlob(video.file, { type: "video/mp4" }), `${replay.id}.mp4`);
      try {
        await send(form);
        return;
      } catch (error) {
        // Too big for this server or channel (Discord's limit depends on boosts): link it instead.
        if (!/HTTP 413|40005/.test(errorMessage(error))) throw error;
      }
    }
    await send(renderedMessage(replay, options.publicUrl));
  }

  return {
    rendered,
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
