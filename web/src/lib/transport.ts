export const API_PREFIX = "/api";
export const API_WS_PATH = `${API_PREFIX}/ws`;

export function apiPath(path: string) {
  return `${API_PREFIX}${path}`;
}

export function websocketUrl() {
  const url = new URL(API_WS_PATH, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
