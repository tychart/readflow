import { clearAuth } from "../app/auth/auth-store";
import { useAppStore } from "../state/store";
import type { JobSummary, WsEnvelope } from "../types/api";
import type { WebSocketStatus } from "../types/events";
import { api } from "./api";
import { websocketUrl } from "./transport";

const HEARTBEAT_MS = 15_000;
const STALE_AFTER_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const RELEASE_GRACE_MS = 250;
/** Server close code for "no valid session" (policy violation). */
const UNAUTHENTICATED_CLOSE_CODE = 1008;

function mergeSnapshotJobs(
  existingJobs: Record<string, JobSummary>,
  snapshotJobs: JobSummary[],
): Record<string, JobSummary> {
  const merged: Record<string, JobSummary> = { ...existingJobs };
  for (const job of snapshotJobs) {
    merged[job.id] = job;
  }
  return merged;
}

interface SocketStatePatch {
  status?: WebSocketStatus;
  lastMessageAt?: number | null;
  error?: string | null;
  reconnectAttempt?: number;
  isStale?: boolean;
}

class LiveClient {
  private subscribers = 0;
  private started = false;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private staleTimer: number | null = null;
  private releaseTimer: number | null = null;
  private reconnectAttempt = 0;
  private hasConnectedOnce = false;
  private intentionalClose = false;

  retain() {
    this.subscribers += 1;
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (this.started) {
      return;
    }
    this.started = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    void this.syncSnapshot("Bootstrap sync failed");
    this.connect();
  }

  release() {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers > 0 || this.releaseTimer !== null) {
      return;
    }
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.subscribers === 0) {
        this.stop();
      }
    }, RELEASE_GRACE_MS);
  }

  /**
   * Sends a playback position update over the WebSocket.
   * Silently no-ops if the socket is not open.
   * Returns true if the message was sent, false otherwise
   * (caller can fall back to HTTP).
   */
  sendPlaybackSync(
    jobId: string,
    currentTimeSeconds: number,
    isPlaying: boolean,
  ): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.socket.send(
        JSON.stringify({
          type: "playback_sync",
          payload: {
            job_id: jobId,
            current_time_seconds: currentTimeSeconds,
            is_playing: isPlaying,
          },
        }),
      );
      return true;
    } catch (error) {
      // Mobile browsers can retain an OPEN-looking socket after the radio has
      // gone away. Progress still has an HTTP path; reconnect the hint channel
      // instead of letting a synchronous send failure interrupt playback.
      this.setSocketState({
        status: "error",
        error:
          error instanceof Error
            ? `Playback sync failed: ${error.message}`
            : "Playback sync failed",
      });
      this.restartConnection();
      return false;
    }
  }

  private store() {
    return useAppStore.getState();
  }

  private setSocketState(state: SocketStatePatch) {
    this.store().setSocketState(state);
  }

  private async syncSnapshot(errorPrefix: string) {
    try {
      const [jobs, voices, adminState] = await Promise.all([
        api.listJobs(),
        api.listVoices(),
        api.getAdminState(),
      ]);
      if (!this.started) {
        return;
      }
      const store = this.store();
      store.setJobs(mergeSnapshotJobs(store.jobs, jobs));
      store.setVoices(voices);
      store.setAdminState(adminState);
    } catch (error) {
      if (!this.started) {
        return;
      }
      this.setSocketState({
        error:
          error instanceof Error
            ? `${errorPrefix}: ${error.message}`
            : errorPrefix,
      });
    }
  }

  private clearTimers() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.staleTimer !== null) {
      window.clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private markActivity(timestamp = Date.now()) {
    if (!this.started) {
      return;
    }
    this.setSocketState({
      lastMessageAt: timestamp,
      isStale: false,
      error: null,
    });
    if (this.staleTimer !== null) {
      window.clearTimeout(this.staleTimer);
    }
    this.staleTimer = window.setTimeout(() => {
      if (!this.started) return;
      // A missing pong or event means an OPEN-looking socket may be a dead
      // mobile connection. A label alone cannot recover the reader, so discard
      // it and let the normal reconnect + snapshot path make state current.
      this.setSocketState({
        isStale: true,
        error: "Live updates are stale. Reconnecting…",
      });
      this.restartConnection();
    }, STALE_AFTER_MS);
  }

  /**
   * A backgrounded mobile tab can keep a WebSocket object alive after its TCP
   * connection is gone. Treat foregrounding and failed writes as a transport
   * discontinuity: reconnect rather than trusting readyState, then sync the
   * authoritative HTTP snapshot on open.
   */
  private restartConnection() {
    if (!this.started) return;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    this.reconnectAttempt = Math.max(1, this.reconnectAttempt);
    this.connect();
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.started) return;
    this.restartConnection();
  };

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.setSocketState({
      status: "reconnecting",
      reconnectAttempt: this.reconnectAttempt,
      error: `Live updates disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`,
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect() {
    if (!this.started) {
      return;
    }
    this.intentionalClose = false;
    this.setSocketState({
      status: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      reconnectAttempt: this.reconnectAttempt,
      isStale: false,
    });

    const socket = new WebSocket(websocketUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (!this.started || this.socket !== socket) {
        return;
      }
      const didReconnect = this.hasConnectedOnce || this.reconnectAttempt > 0;
      this.hasConnectedOnce = true;
      this.reconnectAttempt = 0;
      this.setSocketState({
        status: "open",
        reconnectAttempt: 0,
        error: null,
        isStale: false,
      });
      this.markActivity();
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
      }
      this.heartbeatTimer = window.setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          try {
            this.socket.send("ping");
          } catch (error) {
            this.setSocketState({
              status: "error",
              error:
                error instanceof Error
                  ? `Heartbeat failed: ${error.message}`
                  : "Heartbeat failed",
            });
            this.restartConnection();
          }
        }
      }, HEARTBEAT_MS);
      if (didReconnect) {
        void this.syncSnapshot("Reconnect sync failed");
      }
    });

    socket.addEventListener("message", (event) => {
      if (!this.started || this.socket !== socket) {
        return;
      }
      this.markActivity();
      if (typeof event.data !== "string") {
        this.setSocketState({
          status: "error",
          error: "Received non-text websocket data",
        });
        return;
      }

      const rawPayload = event.data.trim();
      if (!rawPayload) {
        return;
      }

      let payload: WsEnvelope;
      try {
        payload = JSON.parse(rawPayload) as WsEnvelope;
      } catch {
        this.setSocketState({
          status: "error",
          error: `Received malformed websocket data: ${rawPayload.slice(0, 80)}`,
        });
        return;
      }
      if (payload.type === "pong") {
        return;
      }
      this.store().applyEvent(payload);
    });

    socket.addEventListener("error", () => {
      if (!this.started || this.socket !== socket) {
        return;
      }
      this.setSocketState({
        status: "error",
        error: "WebSocket error detected. Reconnecting…",
      });
    });

    socket.addEventListener("close", (event) => {
      // A deliberate replacement (for example after a phone resumes) has
      // already installed a newer socket. Its late close event must not create
      // a second reconnect timer.
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (!this.started || this.intentionalClose) {
        return;
      }
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (event.code === UNAUTHENTICATED_CLOSE_CODE) {
        // The session is gone (logged out, expired, or the account was
        // disabled). Reconnecting would just be refused again, so stop and let
        // the auth gate send the user to the login page.
        clearAuth();
        this.stop();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private stop() {
    this.started = false;
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.hasConnectedOnce = false;
    this.reconnectAttempt = 0;
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.clearTimers();
    this.intentionalClose = true;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
    this.socket = null;
    this.setSocketState({
      status: "idle",
      error: null,
      lastMessageAt: null,
      reconnectAttempt: 0,
      isStale: false,
    });
  }

  resetForTests() {
    this.subscribers = 0;
    this.stop();
  }
}

export const liveClient = new LiveClient();
