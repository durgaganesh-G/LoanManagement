import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { DocumentStatus, ErrorState, Loading, StatusBadge } from "../components/States";
import { formatMoney } from "../utils/formatMoney";
import { useAuth } from "../context/AuthContext";

export default function ApplicationDetailPage() {
  const { applicationId } = useParams();
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  if (isLoading) return <Loading label="Loading application..." />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;
  return <div>
    <div className="breadcrumb"><Link to="/applications">Applications</Link><span>/</span><span>{data.applicationNo}</span></div>
    <div className="page-heading"><div><p className="eyebrow">APPLICATION DETAILS</p><h1>{data.applicant?.fullName}</h1><p className="muted">{data.applicationNo} · Created {new Date(data.createdAt).toLocaleDateString()}</p></div><StatusBadge value={data.status} /></div>
    <div className="detail-grid">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">LOAN REQUEST</p><h2>Application summary</h2></div></div><dl className="data-list">
        <div><dt>Amount requested</dt><dd>{formatMoney(data.loanAmount)}</dd></div><div><dt>Loan term</dt><dd>{data.loanTermMonths} months</dd></div>
        <div><dt>Applicant email</dt><dd>{data.applicant?.email}</dd></div><div><dt>Employment</dt><dd>{data.applicant?.employment || "Not provided"}</dd></div>
      </dl></section>
      <section className="panel"><p className="eyebrow">WORKSPACE</p><h2>{user?.role === "AUDITOR" ? "Read-only review" : "Next steps"}</h2><p className="muted">{user?.role === "AUDITOR" ? "Review the application evidence, decisions, and audit history." : "Upload your ID proof, payslip and bank statement. The figures are extracted and verified from the documents, then the rulebook calculates eligibility."}</p>
        <div className="action-list">{user?.role !== "AUDITOR" && <><Link className="button primary" to={`/applications/${data.id}/documents`}>Upload document →</Link>{data.documents?.some((doc) => doc.status !== "UPLOADED") && <Link className="button secondary" to={`/applications/${data.id}/profile`}>Review extracted profile</Link>}</>}{data.decisions?.length > 0 && <Link className="button secondary" to={`/applications/${data.id}/decision`}>View eligibility result</Link>}{user?.role === "AUDITOR" && <Link className="button secondary" to={`/applications/${data.id}/audit`}>View audit history</Link>}</div>
      </section>
    </div>
    {data.reviews?.length > 0 && <section className="panel"><p className="eyebrow">FINAL LOAN OFFICER DECISION</p><h2>{data.reviews[0].outcome.replaceAll("_", " ")}</h2>{data.reviews[0].score != null && <p><b>Officer score:</b> {data.reviews[0].score} / 100</p>}<p>{data.reviews[0].remarks}</p><p className="muted">Reviewed {new Date(data.reviews[0].createdAt).toLocaleString()}</p></section>}
    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">SUPPORTING DOCUMENTS</p><h2>Documents</h2></div>{user?.role !== "AUDITOR" && <Link to={`/applications/${data.id}/documents`}>Manage →</Link>}</div>
      {data.documents?.length ? <div className="document-list">{data.documents.map((doc) => <div className="document-row" key={doc.id}><span className="file-icon">▤</span><div><b>{doc.originalName}</b><small>{(doc.sizeBytes / 1024).toFixed(0)} KB · {new Date(doc.createdAt).toLocaleDateString()}</small></div><DocumentStatus status={doc.status} /><a href={`${import.meta.env.VITE_API_URL || "http://localhost:4000/api"}/documents/${doc.id}/file`} onClick={async (event) => {
        event.preventDefault();
        try {
          const { data: file } = await api.get(`/documents/${doc.id}/file`, { responseType: "blob" });
          const address = URL.createObjectURL(file); const link = document.createElement("a"); link.href = address; link.download = doc.originalName; link.click(); URL.revokeObjectURL(address);
        } catch { window.alert("Unable to download this document."); }
      }}>Download</a></div>)}</div> : <p className="muted">No documents uploaded yet.</p>}
    </section>
  </div>;
}
