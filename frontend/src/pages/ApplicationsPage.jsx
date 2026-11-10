import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";
import { formatMoney } from "../utils/formatMoney";
import { useAuth } from "../context/AuthContext";

export default function ApplicationsPage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [removingId, setRemovingId] = useState(null);
  const [actionError, setActionError] = useState("");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["applications"],
    queryFn: async () => (await api.get("/applications")).data,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  const items = useMemo(() => {
    if (!data?.items) return [];
    const query = search.trim().toLowerCase();
    return data.items.filter((row) => {
      const matchesStatus = statusFilter === "ALL" || row.status === statusFilter;
      const matchesSearch = !query || [row.applicationNo, row.applicant?.fullName, row.applicant?.email]
        .some((value) => String(value || "").toLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
  }, [data?.items, search, statusFilter]);
  async function removeApplication(row) {
    if (!window.confirm(`Permanently remove loan application ${row.applicationNo}? Its documents and history will also be deleted.`)) return;
    setRemovingId(row.id);
    setActionError("");
    try {
      await api.delete(`/applications/${row.id}`);
      client.setQueryData(["applications"], (previous) => previous ? {
        ...previous,
        items: previous.items.filter((item) => item.id !== row.id),
        total: Math.max(0, previous.total - 1),
      } : previous);
      await client.invalidateQueries({ queryKey: ["applications"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (issue) {
      setActionError(errorMessage(issue));
    } finally {
      setRemovingId(null);
    }
  }
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;
  const statuses = [...new Set(data.items.map((row) => row.status).filter(Boolean))].sort();
  return <div className="applications-page"><div className="page-heading"><div><p className="eyebrow">APPLICATIONS / WORKSPACE</p><h1>Applications</h1><p className="muted">Track applicant progress, documents, and eligibility outcomes.</p></div>{user?.role !== "AUDITOR" && <Link className="button primary" to="/applications/new"><span aria-hidden="true">＋</span> New application</Link>}</div>
    <section className="panel applications-panel"><div className="list-toolbar"><div><p className="eyebrow">APPLICATION REGISTER</p><h2>{data.total} <span>applications in your workspace</span></h2></div><div className="filter-controls"><label className="search-field"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search applications" placeholder="Search name or ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="filter-select"><span className="sr-only">Filter by status</span><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></label></div></div>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {items.length ? <div className="table-wrap"><table><thead><tr><th>Application ID</th><th>Applicant</th><th>Loan amount</th><th>Term</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>
      {items.map((row) => <tr key={row.id}><td className="mono">{row.applicationNo}</td><td><span className="applicant-cell"><span className="table-avatar">{row.applicant?.fullName?.slice(0, 1) || "A"}</span><span>{row.applicant?.fullName}</span></span></td><td>{formatMoney(row.loanAmount)}</td><td>{row.loanTermMonths} mo</td><td><StatusBadge value={row.status} /></td><td>{new Date(row.createdAt).toLocaleDateString()}</td><td><div className="application-row-actions"><Link className="table-action" to={`/applications/${row.id}`}>Details <span aria-hidden="true">→</span></Link>{user?.role !== "AUDITOR" && <button type="button" className="button secondary" onClick={() => removeApplication(row)} disabled={removingId === row.id} aria-label={`Remove application ${row.applicationNo}`}>{removingId === row.id ? "Removing..." : "Remove"}</button>}</div></td></tr>)}
      </tbody></table></div> : <EmptyState>{search || statusFilter !== "ALL" ? "No applications match these filters." : "No applications yet."}</EmptyState>}
    </section>
  </div>;
}
