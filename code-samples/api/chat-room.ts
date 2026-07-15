// Excerpt: src/durable-objects/ChatRoom.ts (Cloudflare Workers API)
//
// One Durable Object instance per conversation. It owns the live WebSocket
// connections for that room and carries BOTH chat traffic (messages, typing,
// receipts) and WebRTC call signaling (offer/answer/ICE + call lifecycle) on
// the same socket — adding video/voice calls required zero new infrastructure.
//
// The interesting decisions are flagged inline; the broadcast-helpers comment
// at the bottom documents a real production bug worth reading.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb } from "../lib/db";
import type { Env } from "../types";

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Every frame type the room accepts — chat, then the call-signaling state
// machine. Call frames are relayed verbatim to the peer; the DO is a dumb
// relay for WebRTC payloads and only interprets lifecycle transitions.
type InboundType =
  | "message"
  | "typing_start"
  | "typing_stop"
  | "message_deleted"
  | "read_receipt"
  | "call_accept"
  | "call_decline"
  | "call_cancel"
  | "call_end"
  | "call_ready"
  | "webrtc_offer"
  | "webrtc_answer"
  | "webrtc_ice";

interface InboundPayload {
  type: InboundType;
  content?: string;
  media_type?: string;
  messageId?: string;
  deletedBy?: string;
  from?: string;
  id?: string;
  ts?: number;
  callId?: string;
}

export class ChatRoom {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Auto-respond to keepalive pings at the runtime level so they do NOT
    // wake a hibernated object (see the hibernation note below).
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ---- Internal POST from the Worker (not a WebSocket upgrade) ----
    // The REST API pushes room events (e.g. a message deleted via HTTP)
    // into the live room through this path.
    if (request.method === "POST" && url.pathname === "/broadcast") {
      try {
        const body = (await request.json()) as InboundPayload;
        this.broadcastToAll(JSON.stringify(body));
        return new Response("ok", { status: 200 });
      } catch {
        return new Response("Bad request", { status: 400 });
      }
    }

    // ---- WebSocket upgrade ----
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Browsers/mobile WS clients can't set headers on the upgrade request,
    // so the Firebase JWT arrives as a query parameter and is verified here
    // — the DO never trusts a socket it didn't authenticate itself.
    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing token", { status: 401 });

    let userId: string;
    try {
      const JWKS = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `https://securetoken.google.com/${this.env.FIREBASE_PROJECT_ID}`,
        audience: this.env.FIREBASE_PROJECT_ID,
      });
      userId = payload.sub as string;
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    // IDOR protection: a valid JWT proves who you are, not that you belong
    // in THIS room. The Worker checks conversation membership against the
    // database before forwarding the upgrade, and marks the forwarded
    // request as verified. Durable Objects are only reachable through the
    // Worker, so this flag can't be forged from outside.
    const verified = url.searchParams.get("verified");
    if (verified !== "true") {
      return new Response("Forbidden: not a participant", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // acceptWebSocket (vs. server.accept()) opts into WebSocket Hibernation;
    // the tag lets us recover the sender's userId after a hibernation wake
    // without any in-memory session map.
    this.state.acceptWebSocket(server, [userId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const senderId = this.state.getTags(ws)[0];

    try {
      const data = JSON.parse(message as string) as InboundPayload;

      switch (data.type) {
        // ---- Regular chat message ----
        // Persistence happens in the REST API before the client emits this
        // frame; the DO only fans out to live sockets. Losing a WS frame
        // never loses a message.
        case "message": {
          if (!data.content) break;
          this.broadcastExcept(ws, JSON.stringify({
            type: "message",
            from: senderId,
            content: data.content,
            media_type: data.media_type ?? null,
            ts: Date.now(),
          }));
          break;
        }

        // ---- Typing indicators: ephemeral, never persisted ----
        case "typing_start":
        case "typing_stop": {
          this.broadcastExcept(ws, JSON.stringify({
            type: data.type,
            from: senderId,
            ts: Date.now(),
          }));
          break;
        }

        // ---- Deletions go to ALL sockets (sender's other devices too) ----
        case "message_deleted": {
          if (!data.messageId) break;
          this.broadcastToAll(JSON.stringify({
            type: "message_deleted",
            messageId: data.messageId,
            deletedBy: data.deletedBy ?? senderId,
            ts: Date.now(),
          }));
          break;
        }

        // ---- Call signaling ----
        // call_accept is the one lifecycle event with a server-side effect:
        // flip the call row to connected — guarded by `status = 'ringing'`
        // so a duplicate/late accept can't resurrect an ended call.
        case "call_accept": {
          if (!data.callId) break;
          try {
            const sql = getDb(this.env.DATABASE_URL);
            await sql`
              UPDATE calls
              SET status = 'connected', connected_at = NOW()
              WHERE id = ${data.callId} AND status = 'ringing'
            `;
          } catch (err) {
            console.error("[ChatRoom] Error updating call status:", err);
          }
          // Fall through: the peer still needs the frame.
        }
        case "call_decline":
        case "call_cancel":
        case "call_end":
        case "call_ready":
        case "webrtc_offer":
        case "webrtc_answer":
        case "webrtc_ice": {
          if (!data.callId) break;
          // Relay verbatim — SDP/ICE payloads are opaque to the server.
          this.broadcastExcept(ws, message as string);
          break;
        }

        default:
          console.warn(`[ChatRoom] Unknown message type: ${data.type}`);
      }
    } catch (err) {
      console.error("[ChatRoom] Message parse error:", err);
    }
  }

  // ---- Broadcast helpers ----
  //
  // These iterate this.state.getWebSockets() — the hibernation-safe API — NOT
  // an in-memory sessions array. With WebSocket Hibernation enabled (see
  // acceptWebSocket + setWebSocketAutoResponse), the DO is evicted from memory
  // during idle periods while the sockets stay alive; the "ping" auto-response
  // intentionally does NOT wake it. A re-instantiated DO (e.g. handling an
  // internal /broadcast POST, or woken by a client WS message) starts with an
  // empty sessions array, so iterating it would silently reach nobody — which
  // is exactly the production bug that made only the FIRST broadcast after an
  // idle period land. getWebSockets() returns every accepted socket,
  // hibernating or not.

  /** Send to every connected client except the sender. */
  private broadcastExcept(senderWs: WebSocket, payload: string): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws !== senderWs && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Send to every connected client (including the one that triggered it). */
  private broadcastToAll(payload: string): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(payload);
      }
    }
  }
}
