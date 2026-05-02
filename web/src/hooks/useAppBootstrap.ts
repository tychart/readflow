import { useEffect } from "react";

import { api } from "../lib/api";
import { useAppStore } from "../state/store";
import type { WsEnvelope } from "../types/api";

const HEARTBEAT_MS = 15_000;
const STALE_AFTER_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;

function websocketUrl() {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function useAppBootstrap() {
  const setJobs = useAppStore((state) => state.setJobs);
  const setVoices = useAppStore((state) => state.setVoices);
  const setAdminState = useAppStore((state) => state.setAdminState);
  const applyEvent = useAppStore((state) => state.applyEvent);
  const setSocketState = useAppStore((state) => state.setSocketState);

  useEffect(() => {
    let cancelled = false;

    const syncSnapshot = async () => {
      try {
        const [jobs, voices, adminState] = await Promise.all([
          api.listJobs(),
          api.listVoices(),
          api.getAdminState(),
        ]);
        if (cancelled) {
          return;
        }
        setJobs(jobs);
        setVoices(voices);
        setAdminState(adminState);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setSocketState({
          error:
            error instanceof Error
              ? `Bootstrap sync failed: ${error.message}`
              : "Bootstrap sync failed",
        });
      }
    };

    void syncSnapshot();

    return () => {
      cancelled = true;
    };
  }, [setAdminState, setJobs, setSocketState, setVoices]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let staleTimer: number | null = null;
    let reconnectAttempt = 0;
    let hasConnectedOnce = false;

    const clearTimers = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (staleTimer !== null) {
        window.clearTimeout(staleTimer);
        staleTimer = null;
      }
    };

    const syncSnapshot = async () => {
      try {
        const [jobs, voices, adminState] = await Promise.all([
          api.listJobs(),
          api.listVoices(),
          api.getAdminState(),
        ]);
        if (disposed) {
          return;
        }
        setJobs(jobs);
        setVoices(voices);
        setAdminState(adminState);
      } catch (error) {
        if (disposed) {
          return;
        }
        setSocketState({
          error:
            error instanceof Error
              ? `Reconnect sync failed: ${error.message}`
              : "Reconnect sync failed",
        });
      }
    };

    const markActivity = (timestamp = Date.now()) => {
      if (disposed) {
        return;
      }
      setSocketState({
        lastMessageAt: timestamp,
        isStale: false,
        error: null,
      });
      if (staleTimer !== null) {
        window.clearTimeout(staleTimer);
      }
      staleTimer = window.setTimeout(() => {
        setSocketState({
          isStale: true,
          error: "Live updates are stale. Polling fallback is active.",
        });
      }, STALE_AFTER_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }
      reconnectAttempt += 1;
      const delay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];
      setSocketState({
        status: "reconnecting",
        reconnectAttempt,
        error: `Live updates disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`,
      });
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      setSocketState({
        status: reconnectAttempt > 0 ? "reconnecting" : "connecting",
        reconnectAttempt,
        isStale: false,
      });

      socket = new WebSocket(websocketUrl());

      socket.addEventListener("open", () => {
        if (disposed) {
          return;
        }
        const didReconnect = hasConnectedOnce || reconnectAttempt > 0;
        hasConnectedOnce = true;
        reconnectAttempt = 0;
        setSocketState({
          status: "open",
          reconnectAttempt: 0,
          error: null,
          isStale: false,
        });
        markActivity();
        if (heartbeatTimer !== null) {
          window.clearInterval(heartbeatTimer);
        }
        heartbeatTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            try {
              socket.send("ping");
            } catch (error) {
              setSocketState({
                status: "error",
                error:
                  error instanceof Error
                    ? `Heartbeat failed: ${error.message}`
                    : "Heartbeat failed",
              });
            }
          }
        }, HEARTBEAT_MS);
        if (didReconnect) {
          void syncSnapshot();
        }
      });

      socket.addEventListener("message", (event) => {
        markActivity();
        let payload: WsEnvelope;
        try {
          payload = JSON.parse(String(event.data)) as WsEnvelope;
        } catch {
          setSocketState({
            status: "error",
            error: "Received malformed websocket data",
          });
          return;
        }
        if (payload.type === "pong") {
          return;
        }
        applyEvent(payload);
      });

      socket.addEventListener("error", () => {
        if (disposed) {
          return;
        }
        setSocketState({
          status: "error",
          error: "WebSocket error detected. Reconnecting…",
        });
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        if (heartbeatTimer !== null) {
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      disposed = true;
      clearTimers();
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      setSocketState({
        status: "closed",
        isStale: false,
      });
    };
  }, [applyEvent, setAdminState, setJobs, setSocketState, setVoices]);
}
