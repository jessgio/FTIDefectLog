import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthProvider";
import { getAllowedEmailDomain, isSupabaseConfigured } from "../lib/supabase";

export function RequireAuth({ children }: { children: React.ReactNode }): React.ReactElement {
  const { session, loading, configured } = useAuth();
  const location = useLocation();

  if (!configured) {
    return (
      <div className="page">
        <div className="card error">
          <div className="cardTitle">Supabase not configured</div>
          <p className="hint">
            Set <span className="mono">VITE_SUPABASE_URL</span> and{" "}
            <span className="mono">VITE_SUPABASE_ANON_KEY</span> in{" "}
            <span className="mono">dashboard/.env</span>, then restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page">
        <div className="card">
          <p className="hint">Loading session…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

export function LoginPage(): React.ReactElement {
  const { signInWithGoogle, configured, session, loading, authError } = useAuth();
  const location = useLocation();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const domain = getAllowedEmailDomain();

  const from =
    typeof location.state === "object" &&
    location.state !== null &&
    "from" in location.state &&
    typeof (location.state as { from?: string }).from === "string"
      ? (location.state as { from: string }).from
      : "/";

  if (loading) {
    return (
      <div className="loginShell">
        <div className="card">
          <p className="hint">Completing sign-in…</p>
        </div>
      </div>
    );
  }

  if (session) {
    return <Navigate to={from} replace />;
  }

  if (!configured) {
    return (
      <div className="loginShell">
        <div className="card error">
          <div className="cardTitle">Setup needed</div>
          <p className="hint">Add Supabase environment variables to dashboard/.env.</p>
        </div>
      </div>
    );
  }

  async function onGoogleSignIn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="loginShell">
      <div className="loginCard card">
        <div className="brand loginBrand">
          <span className="brandMark" aria-hidden="true">
            FTI
          </span>
          <span className="brandText">
            <span className="brandTitle">Defective Stock</span>
            <span className="brandSub">Sign in to continue</span>
          </span>
        </div>

        <p className="hint">
          Use your company Google account
          {domain ? (
            <>
              {" "}
              (<span className="mono">@{domain}</span>)
            </>
          ) : null}
          . Inventory and defect photos are private to authenticated users.
        </p>

        {authError ? (
          <div className="formBanner error" role="alert">
            {authError}
          </div>
        ) : null}

        {error ? (
          <div className="formBanner error" role="alert">
            {error}
          </div>
        ) : null}

        <button type="button" className="primaryBtn loginBtn" disabled={busy} onClick={() => void onGoogleSignIn()}>
          {busy ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </div>
  );
}

export function isAuthReady(): boolean {
  return isSupabaseConfigured();
}
