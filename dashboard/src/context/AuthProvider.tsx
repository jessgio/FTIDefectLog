import React from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  getSupabase,
  isAllowedEmail,
  isSupabaseConfigured,
} from "../lib/supabase";
import { assertAuthenticatedEmail } from "../lib/storage";

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  configured: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const configured = isSupabaseConfigured();

  function rejectSession(email: string | undefined): void {
    const domain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN as string | undefined;
    setAuthError(
      domain
        ? `Sign-in blocked: ${email ?? "unknown"} is not an @${domain.trim()} account.`
        : "Sign-in blocked: this account is not allowed.",
    );
    setSession(null);
  }

  React.useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }

    const supabase = getSupabase();
    let cancelled = false;

    supabase.auth.getSession().then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setAuthError(error.message);
        setLoading(false);
        return;
      }
      const next = data.session;
      if (next?.user?.email && !isAllowedEmail(next.user.email)) {
        void supabase.auth.signOut();
        rejectSession(next.user.email);
      } else {
        setAuthError(null);
        setSession(next);
      }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
        if (nextSession?.user?.email && !isAllowedEmail(nextSession.user.email)) {
          void supabase.auth.signOut();
          rejectSession(nextSession.user.email);
          return;
        }
        setAuthError(null);
      }
      if (event === "SIGNED_OUT") {
        setSession(null);
        return;
      }
      setSession(nextSession);
      if (!nextSession) setLoading(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  async function signInWithGoogle(): Promise<void> {
    const supabase = getSupabase();
    setAuthError(null);
    // Return to app root so OAuth ?code= is exchanged and RequireAuth can load the dashboard.
    const redirectTo = `${window.location.origin}/`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw error;
  }

  async function signOut(): Promise<void> {
    const supabase = getSupabase();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  React.useEffect(() => {
    if (session?.user?.email) {
      try {
        assertAuthenticatedEmail(session.user.email);
      } catch {
        void signOut();
      }
    }
  }, [session?.user?.email]);

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    configured,
    authError,
    signInWithGoogle,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
