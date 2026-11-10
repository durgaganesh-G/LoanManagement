import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/States";
import useIdempotencyKey from "../hooks/useIdempotencyKey";
import { formatMoney } from "../utils/formatMoney";

export default function ReferralsPage() {
  const client = useQueryClient();
  const idempotencyKey = useIdempotencyKey();
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["referrals"], queryFn: async () => (await api.get("/referrals")).data });
  const mutation = useMutation({
    mutationFn: ({ id, outcome, remarks, score }) => {
      const values = { outcome, remarks, score };
      return api.post(`/referrals/${id}/review`, values, { headers: { "Idempotency-Key": idempotencyKey(`review:${id}`, values) } });
    },
    onSuccess: async () => {
      setMessage("Officer decision recorded and application status updated for the applicant.");
      await client.invalidateQueries({ queryKey: ["referrals"] });
      await client.invalidateQueries({ queryKey: ["applications"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (issue) => setMessage(errorMessage(issue)),
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;
  const items = data.items.filter((row) => {
    const query = search.trim().toLowerCase();
    return !query || [row.applicationNo, row.applicant?.fullName, row.decisions?.[0]?.explanation]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
  return <div className="referrals-page"><div className="page-heading"><div><p className="eyebrow">OFFICER WORKSPACE / MANUAL REVIEW</p><h1>Referral queue</h1><p className="muted">Resolve cases that need a careful human review.</p></div><div className="queue-summary"><span className="queue-pulse" /><b>{data.total}</b><span>awaiting review</span></div></div>
    {message && <p role="status" className="notice">{message}</p>}
    <section className="panel referrals-panel"><div className="list-toolbar"><div><p className="eyebrow">OPEN CASES</p><h2>Review queue <span>{data.total} cases</span></h2></div><label className="search-field"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search referrals" placeholder="Search applicant or ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
      {items.length ? <div className="table-wrap"><table><thead><tr><th>Application</th><th>Applicant</th><th>Loan amount</th><th>DTI</th><th>Reason</th><th>Review status</th><th>Officer action</th></tr></thead><tbody>
      {items.map((row) => {
        const reviewStatus = row.reviews?.[0]?.outcome || "PENDING";
        return <tr key={row.id}><td className="mono">{row.applicationNo}</td><td><span className="applicant-cell"><span className="table-avatar">{row.applicant?.fullName?.slice(0, 1) || "A"}</span><span>{row.applicant?.fullName}</span></span></td><td>{formatMoney(row.loanAmount)}</td><td>{row.decisions?.[0]?.dtiPercent == null ? "—" : `${row.decisions[0].dtiPercent}%`}</td><td className="reason-cell">{row.decisions?.[0]?.explanation || "Financial information requires manual review"}</td><td><span className={`review-status review-status-${reviewStatus.toLowerCase()}`}><i />{reviewStatus.replaceAll("_", " ")}</span></td><td><Link className="table-action" to={`/applications/${row.id}`}>Open case <span aria-hidden="true">→</span></Link><form className="review-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const scoreValue = form.get("score"); mutation.mutate({ id: row.id, outcome: form.get("outcome"), remarks: form.get("remarks"), score: scoreValue === "" ? undefined : Number(scoreValue) }); }}><select name="outcome" aria-label="Review outcome"><option value="MORE_INFORMATION">Request more information</option><option value="APPROVED">Record approved</option><option value="DECLINED">Record declined</option></select><input name="remarks" placeholder="Review remarks" required maxLength="2000" /><input name="score" type="number" min="0" max="100" step="1" placeholder="Score (0-100), optional" aria-label="Officer score (0-100)" /><button className="button secondary" disabled={mutation.isPending}>Record review</button></form></td></tr>;
      })}
      </tbody></table></div> : <EmptyState>{search ? "No referrals match your search." : "No referred applications."}</EmptyState>}</section>
  </div>;
}
