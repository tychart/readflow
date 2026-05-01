import { useEffect } from "react";

import { api } from "../lib/api";
import { useAppStore } from "../state/store";
import type { WsEnvelope } from "../types/api";

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
  const setWebsocketStatus = useAppStore((state) => state.setWebsocketStatus);

  useEffect(() => {
    void Promise.all([api.listJobs(), api.listVoices(), api.getAdminState()]).then(
      ([jobs, voices, adminState]) => {
        setJobs(jobs);
        setVoices(voices);
        setAdminState(adminState);
      },
    );
  }, [setAdminState, setJobs, setVoices]);

  useEffect(() => {
    const socket = new WebSocket(websocketUrl());
    setWebsocketStatus("connecting");
    socket.addEventListener("open", () => setWebsocketStatus("open"));
    socket.addEventListener("close", () => setWebsocketStatus("closed"));
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as WsEnvelope;
      applyEvent(payload);
    });
    return () => {
      socket.close();
    };
  }, [applyEvent, setWebsocketStatus]);
}

