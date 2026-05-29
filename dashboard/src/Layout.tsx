import React from "react";
import { NavLink, Outlet } from "react-router-dom";

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? "navLink active" : "navLink";

export function Layout(): React.ReactElement {
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
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
