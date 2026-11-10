import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { ErrorState, Loading, StatusBadge } from "../components/States";
import { formatMoney } from "../utils/formatMoney";
import { hasManualDocumentReview } from "../utils/documentReadiness";

const FINAL_APPLICATION_OUTCOMES = new Set(["ELIGIBLE", "NOT_ELIGIBLE", "APPROVED", "DECLINED", "MORE_INFORMATION"]);

function VerificationSummary({ documents = [] }) {
  return <div className="verification-summary" aria-label="Document verification summary">
    {documents.map((document) => <article className="verification-card" key={document.documentType || document.documentId || document.documentName}>
      <div><b>{document.label || document.documentType?.replaceAll("-", " ") || document.documentName}</b><small>{document.documentName || "No document uploaded"}</small></div>
      <StatusBadge value={document.status || "NOT_PROCESSED"} />
      {document.reason && <p>{document.reason}</p>}
    </article>)}
  </div>;
}

export default function DecisionPage() {
  const { applicationId } = useParams();
  const { data: application, isLoading: applicationLoading, error: applicationError } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["decision", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}/decision`)).data,
  });
  if (applicationLoading || isLoading) return <Loading label="Loading eligibility result..." />;
  if (applicationError) return <ErrorState error={errorMessage(applicationError)} />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;

  const snapshot = data.financialSnapshot || {};
  // A referral made because documents could not be verified. A referral from
  // verified figures (borderline DTI, stated income mismatch) shows the
  // normal calculation view instead.
  const manualReview = hasManualDocumentReview(data) && snapshot.financialInputSource !== "VERIFIED_DOCUMENTS";
  const verifiedSnapshot = snapshot.verifiedFinancialInputs !== false;
  const monthlyNet = manualReview
    ? verifiedSnapshot ? snapshot.monthlyNet : null
    : snapshot.monthlyNet ?? application?.income?.monthlyNet;
  const obligations = manualReview
    ? verifiedSnapshot ? snapshot.monthlyObligations : null
    : snapshot.monthlyObligations ?? application?.income?.monthlyObligations;
  const monthlySurplus = monthlyNet != null && obligations != null ? monthlyNet - obligations : null;
  const dtiScale = Math.min(Math.max(Number(data.dtiPercent) || 0, 0), 100);
  const officerReview = application?.reviews?.[0];
  const applicationOutcome = FINAL_APPLICATION_OUTCOMES.has(application?.status) ? application.status : null;
  const finalOutcome = officerReview?.outcome || applicationOutcome || data.outcome;
  const statusDiffersFromDecision = finalOutcome !== data.outcome;
  const finalHeading = manualReview && !officerReview
    ? "REFER – MANUAL REVIEW REQUIRED"
    : ({
      ELIGIBLE: "Eligible under demo rules",
      REFER: "Manual review required",
      NOT_ELIGIBLE: "Not eligible",
      APPROVED: "Approved by loan officer",
      DECLINED: "Declined by loan officer",
      MORE_INFORMATION: "More information requested",
    }[finalOutcome] || finalOutcome.replaceAll("_", " "));
  const verificationDocuments = snapshot.documentSummary || application?.workflow?.documents || [];
  const failedFields = snapshot.failedFields || application?.workflow?.failures || [];
  const loanAmount = snapshot.loanAmount ?? application?.loanAmount;

  return <div>
    <div className="breadcrumb"><Link to={`/applications/${applicationId}`}>{application?.applicationNo || "Application"}</Link><span>/</span><span>Decision</span></div>
    <div className="page-heading"><div><p className="eyebrow">ELIGIBILITY REVIEW</p><h1>Decision explanation</h1><p className="muted">The result and rule trace are saved in the application audit history.</p></div><StatusBadge value={finalOutcome} /></div>
    <section className={`result-banner result-${String(finalOutcome).toLowerCase()}`}><div className="result-copy"><p className="eyebrow">{officerReview ? "FINAL LOAN OFFICER DECISION" : statusDiffersFromDecision ? "CURRENT APPLICATION RESULT" : manualReview ? "MANUAL REVIEW DECISION" : "AUTOMATED RESULT"} <span className="result-indicator" /></p><h2>{finalHeading}</h2><p className="explanation-text">{officerReview?.remarks || (statusDiffersFromDecision ? `Current application status: ${finalOutcome.replaceAll("_", " ")}.` : manualReview ? "Your application has been referred to a loan officer. The reasons are listed below." : data.explanation)}</p></div><div className="rule-version"><span>RULEBOOK VERSION</span><b>{data.rulebookVersion}</b><small>Decision recorded {new Date(data.createdAt).toLocaleString()}</small></div></section>
    {officerReview && <section className="panel officer-review-summary">
      <p className="eyebrow">LOAN OFFICER REVIEW</p>
      {officerReview.score != null && <p>Officer score <b>{officerReview.score} / 100</b></p>}
      {officerReview.createdAt && <p className="muted">Review recorded {new Date(officerReview.createdAt).toLocaleString()}</p>}
    </section>}
    {manualReview && !officerReview && <section className="panel manual-review-details">
      <p className="eyebrow">MANUAL REVIEW REQUIRED</p><h2>Document verification summary</h2>
      <p className="manual-review-status"><b>Decision Status:</b> REFER <span>·</span> <b>Review Status:</b> MANUAL REVIEW REQUIRED</p>
      <dl className="data-list">
        <div><dt>Application ID</dt><dd>{application?.applicationNo || applicationId}</dd></div>
        <div><dt>Loan amount</dt><dd>{formatMoney(loanAmount)}</dd></div>
        <div><dt>Monthly net income</dt><dd>{monthlyNet == null ? "Not verified" : formatMoney(monthlyNet)}</dd></div>
        <div><dt>Monthly obligations</dt><dd>{obligations == null ? "Not verified" : formatMoney(obligations)}</dd></div>
      </dl>
      <VerificationSummary documents={verificationDocuments} />
      {failedFields.length > 0 && <div className="failed-fields"><h3>Failed or missing fields</h3><ul>{failedFields.map((failure, index) =>
        <li key={`${failure.documentType}-${failure.field}-${index}`}><b>{failure.field || failure.documentName || failure.documentType?.replaceAll("-", " ") || "Verification"}:</b> {failure.reason}</li>)}</ul></div>}
      <p className="explanation-text"><b>Manual review reason:</b> {data.explanation}</p>
      <p className="muted">Decision timestamp: {new Date(data.createdAt).toLocaleString()}</p>
    </section>}
    {finalOutcome === "REFER" && manualReview && !officerReview && <Link className="button secondary" to={`/applications/${applicationId}/documents`}>Correct and re-upload documents</Link>}
    <div className="detail-grid"><section className="panel calculation-panel"><p className="eyebrow">CALCULATION</p><h2>Debt-to-income ratio</h2><div className="dti-value">{data.dtiPercent == null ? "Unavailable" : `${data.dtiPercent}%`}</div><div className="dti-meter" role="img" aria-label={`Debt-to-income ratio ${data.dtiPercent == null ? "unavailable" : `${data.dtiPercent}%`}`}><span style={{ width: `${dtiScale}%` }} /></div><div className="meter-scale"><span>0%</span><span>100%</span></div><p className="muted">DTI = monthly obligations ÷ verified net monthly income × 100. Net income is the payslip net salary matched to the salary credit on the bank statement.</p></section>
      {!officerReview && !statusDiffersFromDecision && <section className="panel"><p className="eyebrow">TRIGGERED RULES</p><h2>Applied checks</h2><ul className="rule-list">{(data.rulesTriggered || []).map((rule) => <li key={rule}>{rule.replaceAll("_", " ")}</li>)}</ul></section>}
    </div>
    <section className="panel affordability-panel"><p className="eyebrow">AFFORDABILITY SNAPSHOT</p><h2>Monthly income after existing obligations</h2>
      {monthlySurplus == null
        ? <p className="muted">Verified net income and existing obligations are needed to calculate this snapshot.</p>
        : <><div className="dti-value">{formatMoney(monthlySurplus)}</div><p className="muted">Verified net monthly income {formatMoney(monthlyNet)} minus existing monthly obligations {formatMoney(obligations)}. This is before any payment for the requested loan; no new-loan repayment is estimated.</p></>}
    </section>
    {!manualReview && snapshot.financialInputSource === "VERIFIED_DOCUMENTS" && <section className="panel figures-used-panel">
      <p className="eyebrow">FIGURES USED</p><h2>Where each figure came from</h2>
      <dl className="data-list">
        <div><dt>Monthly net income — {snapshot.netIncomeSource}{snapshot.evidence?.netSalary?.quote && <small className="evidence-quote">“{snapshot.evidence.netSalary.quote}” — {snapshot.evidence.netSalary.documentName}</small>}{snapshot.evidence?.salaryCredit?.quote && <small className="evidence-quote">“{snapshot.evidence.salaryCredit.quote}” — {snapshot.evidence.salaryCredit.documentName}</small>}</dt><dd>{formatMoney(snapshot.monthlyNet)}</dd></div>
        <div><dt>Existing monthly obligations — {snapshot.obligationsSource || "not available"}{(snapshot.evidence?.monthlyObligations || []).map((item) => <small className="evidence-quote" key={`${item.source}-${item.quote}`}>“{item.quote}” — {item.documentName}</small>)}</dt><dd>{snapshot.monthlyObligations == null ? "Not available" : formatMoney(snapshot.monthlyObligations)}</dd></div>
        {snapshot.declaredMonthlyNet != null && <div><dt>Monthly net income stated on the application</dt><dd>{formatMoney(snapshot.declaredMonthlyNet)}</dd></div>}
      </dl>
      <p className="muted">Explanation: {snapshot.explanationSource === "llm" ? "plain-language summary written by the local AI model (checked against these figures), followed by the rulebook calculation." : "generated from the rulebook calculation."}</p>
    </section>}
    <p className="disclaimer">Illustrative demo rulebook only. This is not a lending approval or a real bank policy.</p>
  </div>;
}
