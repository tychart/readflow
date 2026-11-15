import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { closePlayer } from "../../player/player-store";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

/**
 * The account menu in the header.
 *
 * Logging out must also stop playback: the player lives above the router, so a
 * signed-out tab would otherwise keep reporting a position for a job it can no
 * longer read (the next flush would 401).
 */
export function UserMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [isOpen]);

  if (!auth.user) {
    return null;
  }

  const initial = (auth.user.display_name || auth.user.username)
    .slice(0, 1)
    .toUpperCase();

  const logout = async () => {
    setIsOpen(false);
    closePlayer();
    await api.logout().catch(() => undefined);
    // The gate re-reads the (now anonymous) state and redirects to /login.
    navigate("/login", { replace: true });
    // A full reload drops any cached job data the signed-out user could still
    // see in memory.
    window.location.assign("/login");
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Account menu for ${auth.user.display_name || auth.user.username}`}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--hover-bg)] text-xs font-semibold text-[var(--ink-primary)] transition hover:border-[var(--amber)]"
        data-testid="user-menu-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        {initial}
      </button>
      {isOpen ? (
        <div
          className="absolute right-0 top-10 z-50 w-56 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 shadow-xl"
          role="menu"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-[var(--ink-primary)]">
              {auth.user.display_name}
            </p>
            <p className="truncate text-xs text-[var(--ink-secondary)]">
              @{auth.user.username}
              {auth.user.is_admin ? " · admin" : ""}
            </p>
          </div>
          <button
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--ink-primary)] transition hover:bg-[var(--hover-bg)]"
            onClick={() => {
              setIsOpen(false);
              setShowPassword(true);
            }}
            role="menuitem"
            type="button"
          >
            Change password
          </button>
          <button
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--rose)] transition hover:bg-[var(--hover-bg)]"
            onClick={() => void logout()}
            role="menuitem"
            type="button"
          >
            Log out
          </button>
        </div>
      ) : null}
      {showPassword ? (
        <ChangePasswordDialog onClose={() => setShowPassword(false)} />
      ) : null}
    </div>
  );
}
