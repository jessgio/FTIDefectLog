import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./context/AuthProvider";

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? "navLink active" : "navLink";

export function Layout(): React.ReactElement {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = React.useState(false);

  async function onSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="appShell">
      <header className="appBar">
        <div className="brand">
          <span className="brandMark" aria-hidden="true">
            FTI
          </span>
          <span className="brandText">
            <span className="brandTitle">Defective Stock</span>
            <span className="brandSub">Inventory control</span>
          </span>
        </div>
        <nav className="topNav" aria-label="Main">
          <NavLink to="/" className={navLinkClass} end>
            Dashboard
          </NavLink>
          <NavLink to="/entry" className={navLinkClass}>
            Stock entry
          </NavLink>
          <NavLink to="/history" className={navLinkClass}>
            History
          </NavLink>
        </nav>
        <div className="appBarUser">
          {user?.email ? <span className="appBarEmail hint">{user.email}</span> : null}
          <button
            type="button"
            className="secondaryBtn appBarSignOut"
            disabled={signingOut}
            onClick={() => void onSignOut()}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
