import type { WebSocket } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("voice:stt");
/** Per attempt. The first dial gets two, so the browser (which waits 10s for "ready") hears the outcome either way. */
const FLUX_DIAL_MS = 4000;

interface ClientMsg {
  type: "ready" | "transcript" | "error";
  text?: string;
  final?: boolean;
  event?: string;
  turnIndex?: number;
  message?: string;
}

function send(ws: WebSocket, msg: ClientMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Bridges one browser microphone stream (16kHz linear16 PCM frames) to Deepgram.
 * Primary: Flux (listen v2) with native end-of-turn detection. Fallback: Nova-3 (listen v1).
 */
export async function attachSttSession(client: WebSocket, cfg: Config): Promise<void> {
  if (!cfg.deepgramApiKey) {
    send(client, { type: "error", message: "Deepgram is not configured on the server (DEEPGRAM_API_KEY missing)." });
    client.close(1011, "deepgram not configured");
    return;
  }
  const dg = new DeepgramClient({ apiKey: cfg.deepgramApiKey });
  let closed = false;
  let sendMedia: ((data: Buffer) => void) | null = null;
  let closeUpstream: (() => void) | null = null;

  const pending: Buffer[] = [];
  client.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (sendMedia) sendMedia(buf);
    else if (pending.length < 200) pending.push(buf);
  });
  client.on("close", () => {
    closed = true;
    closeUpstream?.();
  });

  const useFlux = cfg.sttModel.startsWith("flux");
  try {
    if (useFlux) {
      // Flux offers no keepalive and closes on quiet streams, so a dead upstream is re-dialled
      // transparently (mic frames buffer meanwhile) instead of killing the browser's session —
      // otherwise the mic silently dies until the student toggles it.
      let redialing = false;
      const dialFlux = async (): Promise<void> => {
        const conn = await dg.listen.v2.connect({
          model: cfg.sttModel,
          encoding: "linear16",
          sample_rate: 16000,
          eot_threshold: 0.7,
          // Flux also reports when the turn has PROBABLY ended (EagerEndOfTurn), a beat before it is
          // sure, and TurnResumed if it was wrong. The client starts the model's decision on the
          // early signal so the thinking overlaps the wait instead of following it.
          ...(cfg.sttEagerEotThreshold > 0 ? { eager_eot_threshold: cfg.sttEagerEotThreshold } : {}),
          eot_timeout_ms: 5000,
          reconnectAttempts: 0,
        });
        conn.on("message", (m) => {
          if (m.type === "TurnInfo") {
            const isFinal = m.event === "EndOfTurn";
            send(client, { type: "transcript", text: m.transcript, final: isFinal, event: m.event, turnIndex: m.turn_index });
          } else if (m.type === "Error") {
            // Usually precedes a close; the redial handles it. Surface nothing unless we give up.
            logger.warn("flux error", { code: m.code, description: m.description });
          }
        });
        conn.on("error", (e) => logger.warn("flux socket error", { error: e.message }));
        let opened = false;
        conn.on("close", () => {
          // A dial that never opened has nothing to re-dial for: whoever dialled it is already retrying.
          if (!opened || closed || redialing) return;
          sendMedia = null; // buffer frames into `pending` while we re-dial
          redialing = true;
          void (async () => {
            for (const delayMs of [300, 1000, 3000]) {
              await new Promise((r) => setTimeout(r, delayMs));
              if (closed) return;
              try {
                await dialFlux();
                redialing = false;
                logger.info("flux session re-dialled");
                return;
              } catch (e) {
                logger.warn("flux re-dial failed", { error: e instanceof Error ? e.message : String(e) });
              }
            }
            if (!closed) {
              send(client, { type: "error", message: "Voice connection dropped—tap the mic to restart." });
              client.close(1011, "upstream closed");
            }
          })();
        });
        conn.connect();
        try {
          await withTimeout(conn.waitForOpen(), FLUX_DIAL_MS, "deepgram flux connect");
        } catch (e) {
          conn.close();
          throw e;
        }
        opened = true;
        if (closed) {
          conn.close();
          throw new Error("client session closed during dial");
        }
        sendMedia = (b) => {
          try {
            conn.sendMedia(b);
          } catch {
            /* socket closing */
          }
        };
        for (const b of pending.splice(0)) sendMedia(b);
        closeUpstream = () => {
          try {
            conn.sendCloseStream({ type: "CloseStream" });
          } catch {
            /* ignore */
          }
          conn.close();
        };
      };
      // On a poor link a handshake that has not finished in a few seconds is usually lost, not slow:
      // a second short attempt connects where one long wait would just time out.
      await dialFlux().catch((e) => {
        if (closed) throw e;
        logger.warn("flux dial failed; trying once more", { error: e instanceof Error ? e.message : String(e) });
        return dialFlux();
      });
      logger.info("flux session open", { model: cfg.sttModel });
    } else {
      const conn = await dg.listen.v1.connect({
        model: cfg.sttModel || "nova-3",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        interim_results: "true",
        smart_format: "true",
        vad_events: "true",
        endpointing: "400",
        utterance_end_ms: "1200",
        reconnectAttempts: 0,
      } as Parameters<typeof dg.listen.v1.connect>[0]);
      let accumulated = "";
      let turnIndex = 0;
      const flush = () => {
        const text = accumulated.trim();
        accumulated = "";
        if (text) send(client, { type: "transcript", text, final: true, event: "EndOfTurn", turnIndex: turnIndex++ });
      };
      conn.on("message", (raw) => {
        const m = raw as unknown as { type: string; [k: string]: unknown };
        if (m.type === "Results") {
          const alt = (m as { channel?: { alternatives?: { transcript?: string }[] } }).channel?.alternatives?.[0];
          const text = (alt?.transcript ?? "").trim();
          if ((m as { is_final?: boolean }).is_final) {
            if (text) accumulated = `${accumulated} ${text}`.trim();
            if ((m as { speech_final?: boolean }).speech_final) flush();
            else if (accumulated) send(client, { type: "transcript", text: accumulated, final: false, event: "Update", turnIndex });
          } else if (text) {
            send(client, { type: "transcript", text: `${accumulated} ${text}`.trim(), final: false, event: accumulated ? "Update" : "StartOfTurn", turnIndex });
          }
        } else if (m.type === "UtteranceEnd") flush();
        else if (m.type === "SpeechStarted") send(client, { type: "transcript", text: "", final: false, event: "StartOfTurn", turnIndex });
        else if (m.type === "Error") send(client, { type: "error", message: String((m as { description?: string }).description ?? "stt error") });
      });
      conn.on("error", (e) => send(client, { type: "error", message: e.message }));
      conn.on("close", () => {
        if (!closed) client.close(1011, "upstream closed");
      });
      conn.connect();
      await withTimeout(conn.waitForOpen(), 8000, "deepgram nova connect");
      sendMedia = (b) => {
        try {
          conn.sendMedia(b);
        } catch {
          /* ignore */
        }
      };
      closeUpstream = () => {
        try {
          conn.sendCloseStream({ type: "CloseStream" });
        } catch {
          /* ignore */
        }
        conn.close();
      };
      logger.info("nova session open", { model: cfg.sttModel });
    }
    for (const b of pending.splice(0)) sendMedia?.(b);
    send(client, { type: "ready" });
  } catch (e) {
    logger.error("stt session failed", { error: e instanceof Error ? e.message : String(e) });
    send(client, { type: "error", message: `Could not connect to Deepgram: ${e instanceof Error ? e.message : String(e)}` });
    client.close(1011, "upstream failed");
  }
}
