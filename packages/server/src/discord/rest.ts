// Discord's REST API: the one request helper the notifier, the bot and clip replies share.

export const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/dblopez04/kiai, 0.1)";

export class DiscordError extends Error {
  override name = "DiscordError";
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Discord returned HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    this.status = status;
  }
}

export interface DiscordRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  /** Sent as `Authorization: Bot <token>`. Webhook and interaction URLs need none. */
  botToken?: string | undefined;
  body?: unknown;
  fetch?: typeof fetch;
}

/** One request, waiting out up to two rate limits. Throws {@link DiscordError} on any other failure. */
export async function discordRequest(url: string, options: DiscordRequest = {}): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(url, {
      method: options.method ?? "POST",
      headers: {
        "User-Agent": USER_AGENT,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.botToken ? { Authorization: `Bot ${options.botToken}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && attempt < 2) {
      const retry = Number(((await response.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retry, 30) * 1000));
      continue;
    }
    if (!response.ok) throw new DiscordError(response.status, await response.text().catch(() => ""));
    return response;
  }
}
