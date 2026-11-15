import { type FormEvent, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ApiError, api } from "../../lib/api";
import { AUTH_INPUT_CLASS, AUTH_LABEL_CLASS } from "./AuthLayout";

const MIN_PASSWORD_LENGTH = 12;

/**
 * Change the signed-in user's password.
 *
 * The server revokes every *other* session, so the dialog says so: logging out a
 * phone that was left signed in is the point, not a side effect.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setIsPending(true);
    try {
      await api.changePassword(current, next);
      onClose();
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

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <ConfirmDialog
      confirmLabel={isPending ? "Changing…" : "Change password"}
      description="Every other signed-in device will be logged out."
      onCancel={onClose}
      onConfirm={() => void submit()}
      title="Change password"
    >
      <form className="space-y-3" onSubmit={onSubmit}>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="change-current">
            Current password
          </label>
          <input
            autoComplete="current-password"
            className={AUTH_INPUT_CLASS}
            id="change-current"
            onChange={(event) => setCurrent(event.target.value)}
            required
            type="password"
            value={current}
          />
        </div>
        <div>
          <label className={AUTH_LABEL_CLASS} htmlFor="change-new">
            New password
          </label>
          <input
            autoComplete="new-password"
            className={AUTH_INPUT_CLASS}
            id="change-new"
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => setNext(event.target.value)}
            required
            type="password"
            value={next}
          />
          <p className="mt-1 text-xs text-[var(--ink-secondary)]">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        {error ? (
          <p
            className="rounded-lg border border-[var(--rose)]/30 bg-[var(--rose)]/10 px-3 py-2 text-sm text-[var(--rose)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </form>
    </ConfirmDialog>
  );
}
