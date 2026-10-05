// A minimal Discord gateway client: enough to receive slash commands over a websocket, so the
// bot needs no public endpoint (the score library stays off the internet). It heartbeats,
// resumes after a dropped connection, and reconnects with backoff. With no intents, Discord
// sends only READY, RESUMED and interactions.
// https://discord.com/developers/docs/events/gateway

const GATEWAY_URL = "wss://gateway.discord.gg";
/** Closes Discord won't accept a reconnect after: bad token, bad intents, and the like. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Closes that end the session: reconnect with a fresh identify rather than resuming. */
const SESSION_CLOSE_CODES = new Set([4007, 4009]);
/** A close code of our own that Discord doesn't treat as ending the session, so it can resume. */
const RECONNECT = 4000;

export interface GatewayOptions {
  token: string;
  /** Called for every dispatch (READY, INTERACTION_CREATE, ...). Errors are logged, not thrown. */
  onDispatch: (event: string, data: unknown) => void | Promise<void>;
  log: (message: string) => void;
  signal: AbortSignal;
  /** Overrides for tests. */
  WebSocket?: typeof WebSocket;
  url?: string;
  /** First reconnect delay; it doubles up to a minute while connecting keeps failing. */
  backoffMs?: number;
}

interface Session {
  id: string;
  resumeUrl: string;
}

interface Payload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

/** Stay connected until `signal` aborts. Rejects only when Discord refuses the bot for good. */
export async function runGateway(options: GatewayOptions): Promise<void> {
  const Socket = options.WebSocket ?? WebSocket;
  let session: Session | null = null;
  let seq: number | null = null;
  let backoff = options.backoffMs ?? 1000;

  while (!options.signal.aborted) {
    const resuming = session !== null;
    let ready = false;
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new Socket(`${resuming ? session!.resumeUrl : (options.url ?? GATEWAY_URL)}/?v=10&encoding=json`);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let firstBeat: ReturnType<typeof setTimeout> | undefined;
      let acked = true;
      const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
      const beat = () => {
        // No ack since the last beat: the connection is dead even if it looks open.
        if (!acked) return ws.close(RECONNECT, "heartbeat not acknowledged");
        acked = false;
        send(1, seq);
      };
      const onAbort = () => ws.close(1000, "shutting down");
      options.signal.addEventListener("abort", onAbort, { once: true });

      ws.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as Payload;
        if (typeof payload.s === "number") seq = payload.s;
        switch (payload.op) {
          case 10: {
            const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
            firstBeat = setTimeout(() => {
              beat();
              heartbeat = setInterval(beat, interval);
            }, interval * Math.random());
            if (resuming) send(6, { token: options.token, session_id: session!.id, seq });
            else send(2, { token: options.token, intents: 0, properties: { os: process.platform, browser: "kiai", device: "kiai" } });
            break;
          }
          case 11:
            acked = true;
            break;
          case 1:
            send(1, seq);
            break;
          case 7:
            ws.close(RECONNECT, "Discord asked to reconnect");
            break;
          case 9:
            // Invalid session: `d` says whether it can still be resumed.
            if (!payload.d) {
              session = null;
              seq = null;
            }
            setTimeout(() => ws.close(RECONNECT, "invalid session"), 1000 + Math.random() * 4000);
            break;
          case 0: {
            if (payload.t === "READY") {
              const data = payload.d as { session_id: string; resume_gateway_url: string };
              session = { id: data.session_id, resumeUrl: data.resume_gateway_url };
            }
            if (payload.t === "READY" || payload.t === "RESUMED") ready = true;
            Promise.resolve()
              .then(() => options.onDispatch(payload.t!, payload.d))
              .catch((error: unknown) => options.log(`Discord ${payload.t} handler failed: ${error instanceof Error ? error.message : String(error)}`));
            break;
          }
        }
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(firstBeat);
        clearInterval(heartbeat);
        options.signal.removeEventListener("abort", onAbort);
        resolve({ code: event.code, reason: event.reason });
      });
      // An error is always followed by a close, which reconnects.
      ws.addEventListener("error", () => {});
    });

    if (options.signal.aborted) return;
    if (FATAL_CLOSE_CODES.has(closed.code)) {
      throw new Error(`Discord closed the bot's connection for good (${closed.code}${closed.reason ? `: ${closed.reason}` : ""}). Check DISCORD_BOT_TOKEN.`);
    }
    if (SESSION_CLOSE_CODES.has(closed.code)) {
      session = null;
      seq = null;
    }
    if (ready) backoff = options.backoffMs ?? 1000;
    options.log(`Discord connection closed (${closed.code}${closed.reason ? `: ${closed.reason}` : ""}); reconnecting in ${Math.round(backoff / 1000)}s`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoff);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    backoff = Math.min(backoff * 2, 60_000);
  }
}
