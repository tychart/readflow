/**
 * Auth wire types. Instants arrive as ISO-8601 with an explicit `Z`; render them
 * with `lib/time`, never by hand.
 */
export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

/** `GET /api/auth/status`: what the client should render before anything else. */
export interface AuthStatus {
  needs_setup: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface SetupPayload extends LoginPayload {
  display_name?: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  display_name?: string;
  is_admin?: boolean;
}

export interface UpdateUserPayload {
  username?: never;
  is_active?: boolean;
  is_admin?: boolean;
  display_name?: string;
  password?: string;
}
