import { registerSW } from "virtual:pwa-register";

export interface PwaUpdateController {
  /** Starts one service-worker registration for this browser tab. */
  start: () => void;
  /** Subscribes to whether a downloaded version is waiting for user approval. */
  subscribe: (listener: (updateReady: boolean) => void) => () => void;
  /** Activates the waiting worker; it reloads the page once it takes control. */
  reload: () => Promise<void>;
}

type RegisterPwaWorker = (options: {
  immediate: boolean;
  onNeedRefresh: () => void;
}) => () => Promise<void>;

/**
 * Builds a tab-local controller. Keeping its small state here, rather than in a
 * React component, lets the app shell survive route changes without registering
 * a second worker and makes waiting-worker behavior directly testable.
 */
export function createPwaUpdateController(
  register: RegisterPwaWorker,
): PwaUpdateController {
  const listeners = new Set<(updateReady: boolean) => void>();
  let hasRegistered = false;
  let updateReady = false;
  let updateServiceWorker: (() => Promise<void>) | null = null;

  const publish = () => {
    for (const listener of listeners) {
      listener(updateReady);
    }
  };

  return {
    start() {
      if (hasRegistered) return;
      hasRegistered = true;
      updateServiceWorker = register({
        immediate: true,
        onNeedRefresh() {
          updateReady = true;
          publish();
        },
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(updateReady);
      return () => listeners.delete(listener);
    },

    async reload() {
      if (updateServiceWorker) {
        await updateServiceWorker();
      }
    },
  };
}

export const pwaUpdates = createPwaUpdateController(registerSW);
