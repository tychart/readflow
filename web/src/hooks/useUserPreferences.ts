import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { UserPreferences } from "../types/api";

/**
 * The model/voice this user picked when they last created a job.
 *
 * Fetched per form mount rather than cached in the app store: the create form
 * is short-lived (it opens in a dialog) and another tab may have changed the
 * preference in the meantime. `null` means "not loaded yet, or unavailable";
 * the form then falls back to the resident (GPU) choice, which is advisory UI
 * state and never blocks creating a job.
 */
export function useUserPreferences(): UserPreferences | null {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getPreferences()
      .then((next) => {
        if (!cancelled && next) setPreferences(next);
      })
      .catch(() => {
        /* advisory only; the resident/app defaults stand */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return preferences;
}
