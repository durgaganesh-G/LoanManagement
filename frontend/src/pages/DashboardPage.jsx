import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";
import { formatMoney } from "../utils/formatMoney";
import { useAuth } from "../context/AuthContext";

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api.get("/dashboard")).data,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  if (isLoading) return <Loading label="Loading your dashboard..." />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;
  const cards = [
    ["Total applications", data.total, "↗", "metric-total"],
    ["Pending", data.pending, "◷", "metric-pending"],
    ["Approved", data.approved, "✓", "metric-approved"],
    ["Rejected", data.rejected, "×", "metric-rejected"],
    ["Manual review", data.referred, "◉", "metric-referred"],
  ];
  const distribution = [
    ["Approved", data.approved, "approved"],
    ["Manual review", data.referred, "refer"],
    ["Rejected", data.rejected, "rejected"],
    ["In progress", data.pending, "pending"],
  ];
  const total = Number(data.total) || 0;
  const distributionStyle = {
    "--approved-share": `${total ? (Number(data.approved || 0) / total) * 100 : 0}%`,
    "--refer-share": `${total ? (Number(data.referred || 0) / total) * 100 : 0}%`,
    "--rejected-share": `${total ? (Number(data.rejected || 0) / total) * 100 : 0}%`,
  };
  const greetingName = user?.name?.trim().split(/\s+/)[0];
  return <div>
    <div className="dashboard-welcome"><div className="page-heading"><div><p className="eyebrow">{user?.role === "AUDITOR" ? "PORTFOLIO OVERVIEW" : "YOUR WORKSPACE"}</p><h1>{greetingName ? `Welcome back, ${greetingName}` : "Welcome back"}</h1><p className="muted">A clear view of your loan applications and what needs attention.</p></div>{user?.role !== "AUDITOR" && <Link className="button primary" to="/applications/new"><span aria-hidden="true">＋</span> New application</Link>}</div>
      <div className="welcome-orbit" aria-hidden="true"><span /><i /><b /></div>
    </div>
    <div className="metric-grid">{cards.map(([label, value, icon, variant], index) => <article className={`metric-card ${variant}`} key={label} style={{ "--card-order": index }}><div><span>{label}</span><b>{value}</b></div><i aria-hidden="true">{icon}</i></article>)}</div>
    <section className="dashboard-insights">
      <article className="panel distribution-panel"><div className="panel-heading"><div><p className="eyebrow">PORTFOLIO SNAPSHOT</p><h2>Application outcomes</h2></div><span className="insight-total">{data.total} <small>total</small></span></div>
        <div className="distribution-visual"><div className="distribution-ring" style={distributionStyle} role="img" aria-label={`${data.approved} approved, ${data.referred} in manual review, ${data.rejected} rejected, ${data.pending} pending`}><div><b>{data.total}</b><small>applications</small></div></div>
          <div className="distribution-legend">{distribution.map(([label, value, color]) => <div key={label}><span className={`legend-dot ${color}`} /><span>{label}</span><b>{value}</b></div>)}</div>
        </div>
      </article>
      <article className="panel insight-note"><span className="insight-spark" aria-hidden="true">✦</span><p className="eyebrow">A CLEARER PROCESS</p><h2>Every application has a next step.</h2><p className="muted">Keep documents, verified income, and eligibility decisions together in one workspace.</p>{user?.role !== "AUDITOR" && <Link to="/applications/new" className="text-link">Start an application <span aria-hidden="true">→</span></Link>}</article>
    </section>
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>Recent applications</h2></div><Link to="/applications">View all →</Link></div>
      {data.recent.length ? <div className="table-wrap"><table><thead><tr><th>Application</th><th>Applicant</th><th>Amount</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>
        {data.recent.map((item) => <tr key={item.id}><td className="mono">{item.applicationNo}</td><td>{item.applicant?.fullName}</td><td>{formatMoney(item.loanAmount)}</td><td><StatusBadge value={item.status} /></td><td>{new Date(item.createdAt).toLocaleDateString()}</td><td><Link to={`/applications/${item.id}`}>Open</Link></td></tr>)}
      </tbody></table></div> : <EmptyState>No applications yet. Start by creating a new application.</EmptyState>}
    </section>
  </div>;
}
