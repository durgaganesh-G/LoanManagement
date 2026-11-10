import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { ErrorState, Loading, StatusBadge } from "../components/States";
import useIdempotencyKey from "../hooks/useIdempotencyKey";
import { formatMoney } from "../utils/formatMoney";
import { hasManualDocumentReview } from "../utils/documentReadiness";

export function VerificationSummary({ documents = [] }) {
  return <div className="verification-summary" aria-label="Document verification summary">
    {documents.map((document) => <article className="verification-card" key={document.documentType}>
      <div><b>{document.label}</b><small>{document.documentName || "No document uploaded"}</small></div>
      <StatusBadge value={document.status} />
      {document.reason && <p>{document.reason}</p>}
    </article>)}
  </div>;
}

function Evidence({ item }) {
  if (!item?.quote) return null;
  return <small className="evidence-quote">“{item.quote}”{item.documentName ? ` — ${item.documentName}` : ""}</small>;
}

function VerifiedFigures({ verified }) {
  const evidence = verified?.evidence || {};
  const obligations = evidence.monthlyObligations || [];
  return <dl className="data-list verified-figures">
    <div><dt>Monthly gross income<Evidence item={evidence.grossIncome} /></dt><dd>{verified?.monthlyGross == null ? "Not verified" : formatMoney(verified.monthlyGross)}</dd></div>
    <div><dt>Monthly net income (payslip net salary matched to the bank salary credit)<Evidence item={evidence.netSalary} /></dt><dd>{verified?.monthlyNet == null ? "Not verified" : formatMoney(verified.monthlyNet)}</dd></div>
    <div><dt>Salary credited on the bank statement<Evidence item={evidence.salaryCredit} /></dt><dd>{verified?.salaryCredit == null ? "Not found" : formatMoney(verified.salaryCredit)}</dd></div>
    <div><dt>Existing monthly obligations stated in the documents{obligations.map((item) => <Evidence key={`${item.source}-${item.quote}`} item={item} />)}</dt><dd>{verified?.monthlyObligations == null ? "Not stated" : formatMoney(verified.monthlyObligations)}</dd></div>
  </dl>;
}

export default function ExtractedProfilePage() {
  const { applicationId } = useParams();
  const navigate = useNavigate();
  const idempotencyKey = useIdempotencyKey();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
    refetchInterval: (query) => query.state.data?.workflow?.status === "EXTRACTING" ? 2000 : false,
  });
  const [message, setMessage] = useState("");
  const mutation = useMutation({
    mutationFn: (values) => api.patch(`/applications/${applicationId}/profile`, values, {
      headers: { "Idempotency-Key": idempotencyKey(`profile:${applicationId}`, values) },
    }),
    onSuccess: async () => {
      setMessage("Your stated figures were saved and recorded in the audit history.");
      await queryClient.invalidateQueries({ queryKey: ["application", applicationId] });
    },
    onError: (issue) => setMessage(errorMessage(issue)),
  });
  const manualReview = useMutation({
    mutationFn: async () => {
      const { data: result } = await api.post("/ai/run", { applicationId, mode: "MANUAL_REVIEW" }, {
        headers: { "Idempotency-Key": idempotencyKey(`manual-review:${applicationId}`, { applicationId, mode: "MANUAL_REVIEW" }) },
      });
      if (result.outcome !== "REFER" || !result.rulesTriggered?.includes("MANUAL_REVIEW_REQUIRED")) {
        throw new Error("The decision service did not return a saved manual-review result.");
      }
      return result;
    },
    onSuccess: () => navigate(`/applications/${applicationId}/decision`),
    onError: (issue) => setMessage(errorMessage(issue)),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;

  const workflow = data.workflow || {};
  const stated = data.applicantProvidedFinancials || {};
  const extractionPending = workflow.processing || data.documents?.some((document) => document.status === "PROCESSING");
  const documentsReady = workflow.ready === true;
  const manualDecisionRecorded = hasManualDocumentReview(data.decisions?.[0]);
  const extractionAttempted = (data.documents || []).some((document) => document.status !== "UPLOADED");
  const showReview = !documentsReady && !extractionPending && !workflow.unextracted?.length &&
    data.documents?.length > 0 && (extractionAttempted || workflow.missing?.length > 0);

  return <div>
    <div className="breadcrumb"><Link to={`/applications/${applicationId}`}>{data.applicationNo}</Link><span>/</span><span>Extracted profile</span></div>
    <div className="page-heading"><div><p className="eyebrow">EXTRACTED PROFILE</p><h1>Financial information</h1><p className="muted">Each figure was read from your documents and checked against the exact line it came from.</p></div></div>

    {extractionPending && <p role="status" className="notice">Document extraction is in progress. This page refreshes as each document finishes.</p>}
    {!extractionPending && workflow.unextracted?.length > 0 && <p role="status" className="notice">Some documents have not been extracted yet. <Link to={`/applications/${applicationId}/documents`}>Go to documents</Link> and select Extract Documents.</p>}

    {documentsReady && <section className="panel extraction-result extraction-success" role="status">
      <div><p className="eyebrow">VERIFICATION COMPLETE</p><h2>Documents verified</h2><p>The ID proof, payslip and bank statement passed every check, and your net salary matches the salary credited on your bank statement.</p></div>
      <VerificationSummary documents={workflow.documents} />
      <button className="button primary" onClick={() => navigate(`/applications/${applicationId}/eligibility`)}>Proceed to Eligibility <span aria-hidden="true">→</span></button>
    </section>}

    {showReview && <section className="panel extraction-result extraction-review" role="status">
      <div><p className="eyebrow">VERIFICATION INCOMPLETE</p><h2>Manual review required</h2><p>Some document checks did not pass, so an automated eligibility decision cannot be made. You can correct and re-upload the documents, or ask a loan officer to review the application.</p></div>
      <VerificationSummary documents={workflow.documents} />
      {workflow.failures?.length > 0 && <div className="failed-fields">
        <h3>Failed or missing information</h3>
        <ul>{workflow.failures.map((failure, index) => <li key={`${failure.documentType}-${failure.field}-${index}`}>
          <b>{failure.field ? failure.field.replaceAll("_", " ") : failure.documentName || failure.documentType.replaceAll("-", " ")}:</b> {failure.reason}
        </li>)}</ul>
      </div>}
      <div className="form-actions">
        <Link className="button secondary" to={`/applications/${applicationId}/documents`}>Correct and re-upload documents</Link>
        {manualDecisionRecorded
          ? <Link className="button primary" to={`/applications/${applicationId}/decision`}>View decision explanation <span aria-hidden="true">→</span></Link>
          : <button className="button primary" onClick={() => manualReview.mutate()} disabled={manualReview.isPending}>
            {manualReview.isPending ? "Recording referral..." : "Request manual review"}
          </button>}
      </div>
    </section>}

    <section className="panel">
      <p className="eyebrow">VERIFIED FROM DOCUMENTS</p><h2>Figures used for eligibility</h2>
      <p className="muted">Only these verified figures are used to calculate the debt-to-income ratio.</p>
      <VerifiedFigures verified={workflow.verifiedFinancials} />
    </section>

    <section className="panel form-stack extracted-profile-form">
      <div><p className="eyebrow">STATED ON YOUR APPLICATION</p><h2>Your stated figures</h2><p className="muted">Corrections are recorded in the audit history. They do not replace document verification: if your stated net income differs from the verified net income, the application is referred to a loan officer.</p></div>
      {data.documents?.map((doc) => <p className="notice" key={doc.id}>Source: {doc.originalName} · {doc.status === "PROCESSING" ? "Extraction processing" : `Extraction ${doc.status.toLowerCase().replaceAll("_", " ")}`}. {doc.extractionError || ""}</p>)}
      <form className="form-stack" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        mutation.mutate(Object.fromEntries(["monthlyGross", "monthlyNet", "monthlyObligations", "employment", "incomeSource"].map((key) => {
          const value = form.get(key);
          return [key, value === "" ? null : ["monthlyGross", "monthlyNet", "monthlyObligations"].includes(key) ? Number(value) : value];
        })));
      }}>
        <div className="form-grid">
          <label>Monthly gross income<input name="monthlyGross" type="number" min="0" step="0.01" defaultValue={stated.monthlyGross ?? ""} /></label>
          <label>Monthly net income<input name="monthlyNet" type="number" min="0" step="0.01" defaultValue={stated.monthlyNet ?? ""} /></label>
          <label>Existing monthly obligations<input name="monthlyObligations" type="number" min="0" step="0.01" defaultValue={stated.monthlyObligations ?? ""} /></label>
          <label>Employment information<input name="employment" defaultValue={data.income?.employment || data.applicant?.employment || ""} /></label>
          <label>Income source<input name="incomeSource" defaultValue={stated.incomeSource || ""} /></label>
        </div>
        {message && <p role="status" className="notice">{message}</p>}
        <div className="form-actions"><Link className="button secondary" to={`/applications/${applicationId}`}>Back to application</Link><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : "Save corrections"}</button></div>
      </form>
    </section>
  </div>;
}
