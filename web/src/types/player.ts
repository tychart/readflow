export type PlayerState =
  | "idle"
  | "priming"
  | "waiting_for_first_chunk"
  | "ready_paused"
  | "playing"
  | "stalled_waiting_for_next_chunk"
  | "ended"
  | "error";

export type WebSocketStatus = "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface AudioDiagnostics {
  paused: boolean;
  readyState: number;
  networkState: number;
}
