import { api } from "./api";
import { websocketUrl } from "./transport";
import { useAppStore } from "../state/store";
import type { WsEnvelope } from "../types/api";

const HEARTBEAT_MS = 15_000;
const STALE_AFTER_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const RELEASE_GRACE_MS = 250;

function mergeSnapshotJobs(
  existingJobs: ReturnType<typeof useAppStore.getState>["jobs"],
  snapshotJobs: ReturnType<typeof useAppStore.getState>["jobs"],
) {
  const snapshotIds = new Set(snapshotJobs.map((job) => job.id));
  return [...snapshotJobs, ...existingJobs.filter((job) => !snapshotIds.has(job.id))];
}

interface SocketStatePatch {
  status?: ReturnType<typeof useAppStore.getState>["websocketStatus"];
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
          error instanceof Error ? `${errorPrefix}: ${error.message}` : errorPrefix,
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
      this.setSocketState({
        isStale: true,
        error: "Live updates are stale. Polling fallback is active.",
      });
    }, STALE_AFTER_MS);
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];
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
                error instanceof Error ? `Heartbeat failed: ${error.message}` : "Heartbeat failed",
            });
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

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (!this.started || this.intentionalClose) {
        return;
      }
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.scheduleReconnect();
    });
  }

  private stop() {
    this.started = false;
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
      status: "closed",
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
