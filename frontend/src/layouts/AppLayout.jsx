import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { NotificationBell, ProfileMenu } from "../components/TopbarMenus";

export default function AppLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Only one top-bar popover (notifications or profile) is open at a time.
  const [openMenu, setOpenMenu] = useState(null);
  const links = [
    ["/", "Overview", "◫"],
    ["/applications", "Applications", "▤"],
    ...(user?.role === "AUDITOR" ? [] : [["/applications/new", "New application", "＋"]]),
    ...(user?.role === "OFFICER" ? [["/referrals", "Referral queue", "◷"]] : []),
  ];
  const pageName = links.find(([href]) => href === location.pathname)?.[1] ||
    (location.pathname.includes("/decision") ? "Eligibility review" :
      location.pathname.includes("/profile") ? "Financial profile" :
        location.pathname.includes("/documents") ? "Documents" :
          location.pathname.includes("/audit") ? "Audit history" : "Application workspace");

  return <div className={`shell${menuOpen ? " menu-open" : ""}`}>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand" aria-label="Loan Origination and Eligibility Assistant"><span className="brand-mark">L</span><span>Loan Origination<small>ELIGIBILITY ASSISTANT</small></span></div>
        <span className="workspace-label">LENDING WORKSPACE</span>
      </div>
      <nav aria-label="Main navigation">
        <span className="nav-caption">WORKSPACE</span>
        {links.map(([href, label, icon]) => <NavLink key={href} to={href} end={href === "/"} className={({ isActive }) => (isActive && !(href === "/applications" && location.pathname === "/applications/new") ? "active" : undefined)} onClick={() => setMenuOpen(false)}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span>{href === location.pathname && <i aria-hidden="true" />}</NavLink>)}
      </nav>
      <div className="sidebar-note"><span className="sidebar-note-icon">✦</span><div><b>Built for clarity</b><small>Every decision, explained.</small></div></div>
      <div className="sidebar-bottom">
        <span className="avatar">{user?.name?.slice(0, 1) || "U"}</span>
        <div className="user-copy"><b>{user?.name}</b><small>{user?.role === "AUDITOR" ? "Credit risk / audit" : user?.role?.toLowerCase()}</small></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <button className="menu-toggle" type="button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><span /><span /><span /></button>
        <div className="topbar-title"><small>LOAN ASSISTANT <span>/</span> WORKSPACE</small><strong>{pageName}</strong></div>
        <div className="topbar-right">
          <span className="secure-label"><i /> Secure workspace</span>
          <NotificationBell open={openMenu === "notifications"} onOpenChange={(open) => setOpenMenu(open ? "notifications" : null)} />
          <ProfileMenu open={openMenu === "profile"} onOpenChange={(open) => setOpenMenu(open ? "profile" : null)} />
        </div>
      </header>
      <section className="content"><Outlet /></section>
    </main>
  </div>;
}
