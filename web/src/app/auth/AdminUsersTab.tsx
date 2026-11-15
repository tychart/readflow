import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "../../lib/api";
import { formatDateTime } from "../../lib/time";
import type { AuthUser } from "../../types/auth";
import {
  AUTH_BUTTON_CLASS,
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
} from "./AuthLayout";

/**
 * Admin-only account management.
 *
 * There is no self-service registration: an admin creates every account, can
 * disable one (which revokes its live sessions and sockets) and can reset a
 * password (which does the same). Delete is deliberately absent — disabling
 * keeps the owner of existing jobs intact.
 */
export function AdminUsersTab() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await api.adminUsers());
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Could not load users",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setIsPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "The request failed",
      );
    } finally {
      setIsPending(false);
    }
  };

  const createUser = async () => {
    await run(
      () =>
        api.createUser({
          username,
          password,
          display_name: displayName || undefined,
          is_admin: isAdmin,
        }),
      `Created ${username}`,
    );
    setUsername("");
    setDisplayName("");
    setPassword("");
    setIsAdmin(false);
  };

  const resetPassword = async (user: AuthUser) => {
    const next = window.prompt(
      `New password for ${user.username} (12+ characters)`,
    );
    if (!next) {
      return;
    }
    await run(
      () => api.updateUser(user.id, { password: next }),
      `Password reset for ${user.username}; their sessions were revoked`,
    );
  };

  return (
    <div className="space-y-6" data-testid="admin-users-tab">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--ink-primary)]">
          Accounts
        </h2>
        <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-[var(--hover-bg)] text-xs uppercase tracking-wider text-[var(--ink-secondary)]">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  className="border-t border-[var(--line)]"
                  key={user.id}
                  data-testid={`admin-user-row-${user.username}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-[var(--ink-primary)]">
                      {user.display_name}
                    </div>
                    <div className="text-xs text-[var(--ink-secondary)]">
                      @{user.username}
                      {user.is_active ? "" : " · disabled"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {user.is_admin ? "Administrator" : "Listener"}
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {formatDateTime(user.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        className="rounded-lg px-2 py-1 text-xs text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
                        disabled={isPending}
                        onClick={() =>
                          void run(
                            () =>
                              api.updateUser(user.id, {
                                is_admin: !user.is_admin,
                              }),
                            `${user.username} is now ${
                              user.is_admin ? "a listener" : "an administrator"
                            }`,
                          )
                        }
                        type="button"
                      >
                        {user.is_admin ? "Make listener" : "Make admin"}
                      </button>
                      <button
                        className="rounded-lg px-2 py-1 text-xs text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
                        disabled={isPending}
                        onClick={() => void resetPassword(user)}
                        type="button"
                      >
                        Reset password
                      </button>
                      <button
                        className={`rounded-lg px-2 py-1 text-xs transition hover:bg-[var(--hover-bg)] ${
                          user.is_active
                            ? "text-[var(--rose)]"
                            : "text-[var(--emerald)]"
                        }`}
                        disabled={isPending}
                        onClick={() =>
                          void run(
                            () =>
                              api.updateUser(user.id, {
                                is_active: !user.is_active,
                              }),
                            `${user.username} is now ${
                              user.is_active ? "disabled" : "active"
                            }`,
                          )
                        }
                        type="button"
                      >
                        {user.is_active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--line)] p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--ink-primary)]">
          Add an account
        </h2>
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createUser();
          }}
        >
          <div>
            <label className={AUTH_LABEL_CLASS} htmlFor="new-user-username">
              Username
            </label>
            <input
              className={AUTH_INPUT_CLASS}
              id="new-user-username"
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </div>
          <div>
            <label className={AUTH_LABEL_CLASS} htmlFor="new-user-display">
              Display name
            </label>
            <input
              className={AUTH_INPUT_CLASS}
              id="new-user-display"
              onChange={(event) => setDisplayName(event.target.value)}
              value={displayName}
            />
          </div>
          <div>
            <label className={AUTH_LABEL_CLASS} htmlFor="new-user-password">
              Password (12+ characters)
            </label>
            <input
              className={AUTH_INPUT_CLASS}
              id="new-user-password"
              minLength={12}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--ink-secondary)] sm:col-span-2">
            <input
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
              type="checkbox"
            />
            Administrator (can manage accounts and the queue)
          </label>
          <button
            className={AUTH_BUTTON_CLASS}
            disabled={isPending}
            type="submit"
          >
            {isPending ? "Creating…" : "Create account"}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-[var(--line)] p-4">
        <h2 className="mb-1 text-sm font-semibold text-[var(--ink-primary)]">
          Database backup
        </h2>
        <p className="mb-3 text-xs text-[var(--ink-secondary)]">
          Downloads a <code>pg_dump</code> custom-format archive. It contains
          every account, job and source text, so treat it like the database
          itself.
        </p>
        <button
          className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
          disabled={isPending}
          onClick={() =>
            void run(async () => {
              const { blob, filename } = await api.downloadBackup();
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = filename;
              anchor.click();
              URL.revokeObjectURL(url);
            }, "Backup downloaded")
          }
          type="button"
        >
          Download backup
        </button>
      </section>

      {error ? (
        <p
          className="rounded-lg border border-[var(--rose)]/30 bg-[var(--rose)]/10 px-3 py-2 text-sm text-[var(--rose)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          className="rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-3 py-2 text-sm text-[var(--emerald)]"
          role="status"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
