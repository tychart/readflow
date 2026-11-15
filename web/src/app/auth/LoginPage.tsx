import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { ApiError, api } from "../../lib/api";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AuthLayout,
} from "./AuthLayout";
import { applyAuthStatus } from "./auth-store";

/** Where to send the user after login, refusing anything that is not a local path. */
function safeNext(raw: string | null): string {
  if (!raw?.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }
  return raw;
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const next = safeNext(params.get("next"));

  if (auth.phase === "setup") {
    return <Navigate replace to="/setup" />;
  }
  if (auth.phase === "authenticated") {
    return <Navigate replace to={next} />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsPending(true);
    try {
      const status = await api.login({ username, password });
      applyAuthStatus(status);
      navigate(next, { replace: true });
    } catch (cause) {
      // The server is deliberately generic here, so the UI repeats it verbatim
      // rather than inventing a more helpful message that would leak whether
      // the username exists.
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
    <AuthLayout subtitle="Sign in to keep listening." title="Welcome back">
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="login-username">
            Username
          </label>
          <input
            autoComplete="username"
            className={AUTH_INPUT_CLASS}
            id="login-username"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </div>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="login-password">
            Password
          </label>
          <input
            autoComplete="current-password"
            className={AUTH_INPUT_CLASS}
            id="login-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
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
          {isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-[var(--ink-secondary)]">
        Accounts are created by an administrator.{" "}
        <Link className="underline hover:text-[var(--ink-primary)]" to="/">
          Back to the library
        </Link>
      </p>
    </AuthLayout>
  );
}
