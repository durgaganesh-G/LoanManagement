import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../context/AuthContext";

const ROLE_LABELS = {
  APPLICANT: "Applicant",
  OFFICER: "Loan officer",
  AUDITOR: "Credit risk / audit",
};

// Close a popover on an outside click or the Escape key.
function useDismiss(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (ref.current && !ref.current.contains(event.target)) close(); };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

function initialOf(name) {
  return name?.trim()?.slice(0, 1)?.toUpperCase() || "U";
}

// Read state is remembered per user in this browser.
function seenKey(user) {
  return `bnk-notifications-seen:${user?.id || user?.email || user?.name || "user"}`;
}

function readSeen(key) {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable (private mode); read state then lasts for the session only.
  }
}

export function timeAgo(value, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(value).toLocaleDateString();
}

function BellIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>;
}

export function NotificationBell({ open, onOpenChange }) {
  const { user } = useAuth();
  const key = seenKey(user);
  const ref = useRef(null);
  const [seenAt, setSeenAt] = useState(() => readSeen(key));
  const [highlightAfter, setHighlightAfter] = useState(seenAt);
  useDismiss(ref, open, () => onOpenChange(false));
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get("/notifications")).data,
    enabled: Boolean(user),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const items = data?.items || [];
  const unread = items.filter((item) => new Date(item.createdAt).getTime() > seenAt).length;

  function toggle() {
    if (!open) {
      // Opening the list marks everything shown as read; items that were
      // new stay highlighted while the list is open.
      const now = Date.now();
      setHighlightAfter(seenAt);
      setSeenAt(now);
      writeSeen(key, now);
    }
    onOpenChange(!open);
  }

  return <div className="topbar-menu" ref={ref}>
    <button
      type="button"
      className="icon-button notification-button"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={toggle}
    >
      <BellIcon />
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
    </button>
    {open && <div className="topbar-popover notification-panel" role="dialog" aria-label="Notifications">
      <div className="popover-heading"><b>Notifications</b>{items.length > 0 && <small>{items.length} recent</small>}</div>
      {isLoading ? <p className="popover-empty">Loading notifications…</p>
        : error ? <p className="popover-empty">{errorMessage(error)} <button type="button" className="link-button" onClick={() => refetch()}>Try again</button></p>
          : !items.length ? <p className="popover-empty">No notifications yet. Updates about your documents and decisions will appear here.</p>
            : <ul className="notification-list">{items.map((item) => <li key={item.id} className={`notification-item tone-${item.tone}${new Date(item.createdAt).getTime() > highlightAfter ? " is-new" : ""}`}>
              <Link to={item.link} onClick={() => onOpenChange(false)}>
                <span className="notification-dot" aria-hidden="true" />
                <span className="notification-copy">
                  <b>{item.title}</b>
                  <small>{item.message}</small>
                  <time dateTime={item.createdAt}>{timeAgo(item.createdAt)}</time>
                </span>
              </Link>
            </li>)}</ul>}
    </div>}
  </div>;
}

export function ProfileMenu({ open, onOpenChange }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ref = useRef(null);
  useDismiss(ref, open, () => onOpenChange(false));
  const initial = initialOf(user?.name);

  function signOut() {
    onOpenChange(false);
    logout();
    queryClient.clear();
    navigate("/login");
  }

  return <div className="topbar-menu" ref={ref}>
    <button
      type="button"
      className="profile-button"
      aria-label="Open profile menu"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      <span className="topbar-avatar">{initial}</span>
      <span className="profile-button-name">{user?.name}</span>
      <span className="profile-chevron" aria-hidden="true">▾</span>
    </button>
    {open && <div className="topbar-popover profile-panel" role="dialog" aria-label="Profile">
      <div className="profile-summary">
        <span className="avatar profile-avatar">{initial}</span>
        <div>
          <b>{user?.name}</b>
          <small>{user?.email || "Email not available"}</small>
          <span className="profile-role">{ROLE_LABELS[user?.role] || user?.role}</span>
        </div>
      </div>
      <button type="button" className="sign-out-button" onClick={signOut}>Sign out <span aria-hidden="true">↗</span></button>
    </div>}
  </div>;
}
