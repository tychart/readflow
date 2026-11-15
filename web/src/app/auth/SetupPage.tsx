import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { ApiError, api } from "../../lib/api";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AuthLayout,
} from "./AuthLayout";
import { applyAuthStatus } from "./auth-store";

/** Minimum the server accepts; the form mirrors it so the user is not surprised. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * First-run setup: create the one admin account.
 *
 * Reachable only while the install has no users; once it does, the server
 * answers 409 and the gate sends the visitor to the login page.
 */
export function SetupPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  if (auth.phase === "authenticated") {
    return <Navigate replace to="/" />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match");
      return;
    }
    setIsPending(true);
    try {
      const status = await api.setup({
        username,
        password,
        display_name: displayName || undefined,
      });
      applyAuthStatus(status);
      navigate("/", { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Could not reach the server",
      );
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AuthLayout
      subtitle="This install has no accounts yet. The first one is the administrator."
      title="Set up ReadFlow"
    >
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="setup-username">
            Username
          </label>
          <input
            autoComplete="username"
            className={AUTH_INPUT_CLASS}
            id="setup-username"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </div>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="setup-display-name">
            Display name (optional)
          </label>
          <input
            autoComplete="name"
            className={AUTH_INPUT_CLASS}
            id="setup-display-name"
            onChange={(event) => setDisplayName(event.target.value)}
            value={displayName}
          />
        </div>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="setup-password">
            Password
          </label>
          <input
            autoComplete="new-password"
            className={AUTH_INPUT_CLASS}
            id="setup-password"
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="setup-confirm">
            Confirm password
          </label>
          <input
            autoComplete="new-password"
            className={AUTH_INPUT_CLASS}
            id="setup-confirm"
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => setConfirm(event.target.value)}
            required
            type="password"
            value={confirm}
          />
        </div>
        {error ? (
          <p
            className="rounded-lg border border-[var(--rose)]/30 bg-[var(--rose)]/10 px-3 py-2 text-sm text-[var(--rose)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <button
          className={AUTH_BUTTON_CLASS}
          disabled={isPending}
          type="submit"
        >
          {isPending ? "Creating…" : "Create administrator"}
        </button>
      </form>
    </AuthLayout>
  );
}
