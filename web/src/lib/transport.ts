/**
 * API path prefix for all backend endpoints.
 */
export const API_PREFIX = "/api";

/**
 * WebSocket endpoint path.
 */
export const API_WS_PATH = `${API_PREFIX}/ws`;

/**
 * Constructs a full API path with the configured prefix.
 */
export function apiPath(path: string): string {
  return `${API_PREFIX}${path}`;
}

/**
 * Constructs the WebSocket URL based on the current page protocol.
 * Automatically upgrades http(s) to ws(s).
 */
export function websocketUrl(): string {
  const url = new URL(API_WS_PATH, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
