// The Discord bot's slash commands. /clip cuts a stretch of a replay's rendered video: the bot
// queues a clip (and a render, if the replay has none), replies "clipping…", and the render
// worker edits that reply into the clip when it's cut.

import { createClip, parseClipRange } from "../clips/store.ts";
import type { Sql } from "../db/index.ts";
import { errorMessage, UserError } from "../errors.ts";
import { clipPendingMessage, replayTitle } from "../render/notify.ts";
import { getReplay, searchReplays, type ReplayView } from "../replays/store.ts";
import { runGateway } from "./gateway.ts";
import { API, discordRequest } from "./rest.ts";

// https://discord.com/developers/docs/interactions/receiving-and-responding
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;
const REPLY = 4;
const AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 1 << 6;
const STRING = 3;

export const CLIP_COMMAND = {
  name: "clip",
  description: "Clip part of a replay's video",
  // Usable where the bot is installed in a server, and anywhere once you install it on your account.
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    { type: STRING, name: "query", description: "Map, difficulty, player or mods; pick a replay from the list", required: true, autocomplete: true, max_length: 100 },
    { type: STRING, name: "start", description: "Where the clip starts in the video, like 1:23 or 83", required: true, max_length: 12 },
    { type: STRING, name: "end", description: "Where it ends, like 1:45", required: true, max_length: 12 },
  ],
};

export interface BotDeps {
  sql: Sql;
  botToken: string;
  /** Only this Discord user can use the commands: they render and clip on your hardware. */
  ownerId: string;
  publicUrl: string | undefined;
  fetch?: typeof fetch;
  log: (message: string) => void;
}

interface Interaction {
  id: string;
  application_id: string;
  token: string;
  type: number;
  data?: { name: string; options?: { name: string; value: unknown; focused?: boolean }[] };
  member?: { user: { id: string } };
  user?: { id: string };
}

const ephemeral = (content: string) => ({ type: REPLY, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

/** An autocomplete choice: the map and the play, in Discord's 100 characters. */
export function replayChoice(r: ReplayView): { name: string; value: string } {
  const mods = r.mods.length ? r.mods.map((mod) => mod.acronym).join("") : "NM";
  const tail = ` · ${(r.accuracy * 100).toFixed(2)}% ${mods} · ${r.player_name} · ${r.played_at.slice(0, 10)}`;
  const title = replayTitle(r);
  const room = 100 - tail.length;
  return { name: (title.length > room ? `${title.slice(0, room - 1)}…` : title) + tail, value: r.id };
}

/** The replay a /clip query means: the one picked from the list, else the newest that matches. */
async function findReplay(sql: Sql, query: string): Promise<ReplayView | null> {
  const picked = /^[a-z0-9]{10}$/.test(query) ? await getReplay(sql, query) : null;
  return picked ?? (await searchReplays(sql, query, 1))[0] ?? null;
}

/** The interaction's response body, or null for interactions the bot doesn't handle. */
export async function handleInteraction(deps: BotDeps, interaction: Interaction): Promise<object | null> {
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  const options = new Map((interaction.data?.options ?? []).map((option) => [option.name, String(option.value ?? "")]));
  if (interaction.data?.name !== CLIP_COMMAND.name) return null;

  if (interaction.type === AUTOCOMPLETE) {
    const choices = userId === deps.ownerId ? (await searchReplays(deps.sql, options.get("query") ?? "", 25)).map(replayChoice) : [];
    return { type: AUTOCOMPLETE_RESULT, data: { choices } };
  }
  if (interaction.type !== APPLICATION_COMMAND) return null;

  if (userId !== deps.ownerId) return ephemeral("Only the bot's owner can make clips: they render on their machine.");
  if (!deps.publicUrl) return ephemeral("Set PUBLIC_URL on the server first: clips play from the public replay site.");
  let range;
  try {
    range = parseClipRange(options.get("start") ?? "", options.get("end") ?? "");
  } catch (error) {
    if (error instanceof UserError) return ephemeral(error.message);
    throw error;
  }
  const query = (options.get("query") ?? "").trim();
  const replay = await findReplay(deps.sql, query);
  if (!replay) return ephemeral(`No replay matches "${query}". Upload it with \`kiai render\` first.`);

  const { clip, rendering } = await createClip(deps.sql, {
    replayId: replay.id,
    ...range,
    discord: { application_id: interaction.application_id, token: interaction.token, user_id: deps.ownerId },
  });
  deps.log(`[clip ${clip.id} replay ${replay.id}] queued from Discord${rendering ? ", rendering the replay first" : ""}`);
  return { type: REPLY, data: clipPendingMessage(replay, clip, deps.publicUrl, rendering) };
}

/** Connect to Discord, register the commands, and answer them until `signal` aborts. */
export async function runDiscordBot(deps: BotDeps & { signal: AbortSignal; WebSocket?: typeof WebSocket }): Promise<void> {
  const request = (url: string, method: "POST" | "PUT", body: unknown, auth: boolean) =>
    discordRequest(url, { method, body, ...(auth ? { botToken: deps.botToken } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  let registered = false;

  await runGateway({
    token: deps.botToken,
    signal: deps.signal,
    log: deps.log,
    ...(deps.WebSocket ? { WebSocket: deps.WebSocket } : {}),
    async onDispatch(event, data) {
      if (event === "READY" && !registered) {
        const { application, user } = data as { application: { id: string }; user: { username: string } };
        // Overwrites the bot's global commands with these: the same list every start is a no-op.
        await request(`${API}/applications/${application.id}/commands`, "PUT", [CLIP_COMMAND], true);
        registered = true;
        deps.log(`Discord bot ${user.username} connected; /clip is registered`);
      }
      if (event !== "INTERACTION_CREATE") return;
      const interaction = data as Interaction;
      let response: object | null;
      try {
        response = await handleInteraction(deps, interaction);
      } catch (error) {
        deps.log(`Discord /${interaction.data?.name} failed: ${errorMessage(error)}`);
        response = interaction.type === AUTOCOMPLETE ? null : ephemeral(`Something went wrong: ${errorMessage(error).slice(0, 300)}`);
      }
      if (response) await request(`${API}/interactions/${interaction.id}/${interaction.token}/callback`, "POST", response, false);
    },
  });
}
