import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { ErrorState, Loading } from "../components/States";
import useIdempotencyKey from "../hooks/useIdempotencyKey";
import { formatMoney } from "../utils/formatMoney";

export default function EligibilityPage() {
  const { applicationId } = useParams();
  const navigate = useNavigate();
  const idempotencyKey = useIdempotencyKey();
  const applicationQuery = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
  });
  const rulebooksQuery = useQuery({
    queryKey: ["eligibility-rulebooks"],
    queryFn: async () => (await api.get("/eligibilityrules")).data,
  });
  const calculation = useMutation({
    mutationFn: async ({ input, rulebook }) => {
      const { data: result } = await api.post("/ai/run", { applicationId, mode: "ELIGIBILITY" }, {
        headers: { "Idempotency-Key": idempotencyKey(`eligibility:${applicationId}`, input) },
      });
      if (!["ELIGIBLE", "NOT_ELIGIBLE", "REFER"].includes(result.outcome) ||
        !Array.isArray(result.rulesTriggered) || result.rulebookVersion !== rulebook.version) {
        throw new Error("The eligibility service returned an invalid decision response.");
      }
      return result;
    },
    onSuccess: () => navigate(`/applications/${applicationId}/decision`),
  });

  if (applicationQuery.isLoading || rulebooksQuery.isLoading) return <Loading label="Loading verified financial details..." />;
  if (applicationQuery.error) return <ErrorState error={errorMessage(applicationQuery.error)} retry={applicationQuery.refetch} />;
  if (rulebooksQuery.error) return <ErrorState error={errorMessage(rulebooksQuery.error)} retry={rulebooksQuery.refetch} />;

  const application = applicationQuery.data;
  const activeRulebook = rulebooksQuery.data.items?.find((rulebook) => rulebook.active);
  if (!activeRulebook) return <ErrorState error="No active eligibility rulebook is configured." retry={rulebooksQuery.refetch} />;
  const workflow = application.workflow || {};
  const verified = workflow.verifiedFinancials || {};
  const stated = application.applicantProvidedFinancials || {};
  const ready = workflow.ready === true;
  const tolerance = activeRulebook.config.declaredIncomeTolerancePercent ?? 1;
  const input = {
    loanAmount: application.loanAmount,
    loanTermMonths: application.loanTermMonths,
    monthlyNet: verified.monthlyNet,
    monthlyObligations: verified.monthlyObligations,
    statedMonthlyNet: stated.monthlyNet,
    statedMonthlyObligations: stated.monthlyObligations,
    rulebookVersion: activeRulebook.version,
  };
  const errorMessageText = calculation.error ? errorMessage(calculation.error) : "";

  return <div>
    <div className="breadcrumb"><Link to={`/applications/${applicationId}`}>{application.applicationNo}</Link><span>/</span><span>Eligibility</span></div>
    <div className="page-heading"><div><p className="eyebrow">ELIGIBILITY REVIEW</p><h1>Eligibility check</h1><p className="muted">The deterministic rulebook calculates the debt-to-income ratio from the figures verified from your documents. The AI only reads the documents and words the explanation; it does not make the decision.</p></div></div>

    {!ready && <section className="panel extraction-result extraction-review" role="status">
      <div><p className="eyebrow">DOCUMENTS NOT VERIFIED</p><h2>Eligibility cannot run yet</h2><p>{workflow.reason || "All three documents must be uploaded, extracted and verified before eligibility is calculated."}</p></div>
      <div className="form-actions"><Link className="button primary" to={`/applications/${applicationId}/profile`}>Review extracted profile <span aria-hidden="true">→</span></Link></div>
    </section>}

    <div className="detail-grid">
      <section className="panel"><p className="eyebrow">VERIFIED FROM DOCUMENTS</p><h2>Monthly financial position</h2><dl className="data-list">
        <div><dt>Monthly gross income</dt><dd>{verified.monthlyGross == null ? "Not verified" : formatMoney(verified.monthlyGross)}</dd></div>
        <div><dt>Monthly net income (used for DTI)</dt><dd>{verified.monthlyNet == null ? "Not verified" : formatMoney(verified.monthlyNet)}</dd></div>
        <div><dt>Existing monthly obligations in documents</dt><dd>{verified.monthlyObligations == null ? "Not stated" : formatMoney(verified.monthlyObligations)}</dd></div>
        <div><dt>Monthly net income you stated</dt><dd>{stated.monthlyNet == null ? "Not stated" : formatMoney(stated.monthlyNet)}</dd></div>
        <div><dt>Monthly obligations you stated</dt><dd>{stated.monthlyObligations == null ? "Not stated" : formatMoney(stated.monthlyObligations)}</dd></div>
      </dl></section>
      <section className="panel"><p className="eyebrow">LOAN REQUEST</p><h2>Eligibility inputs</h2><dl className="data-list">
        <div><dt>Application ID</dt><dd>{application.applicationNo}</dd></div>
        <div><dt>Loan amount</dt><dd>{formatMoney(application.loanAmount)}</dd></div>
        <div><dt>Loan term</dt><dd>{application.loanTermMonths} months</dd></div>
        <div><dt>Rulebook version</dt><dd>{activeRulebook.version}</dd></div>
      </dl></section>
    </div>
    <section className="panel eligibility-rulebook">
      <p className="eyebrow">DTI AND ELIGIBILITY RULES</p><h2>Deterministic calculation</h2>
      <p>DTI = monthly obligations ÷ verified monthly net income × 100. Obligations are the amount stated in your documents; if you stated a higher amount on the application, the higher amount is used.</p>
      <dl className="data-list">
        <div><dt>Eligible below</dt><dd>{activeRulebook.config.eligibleBelowDti}% DTI</dd></div>
        <div><dt>Not eligible above</dt><dd>{activeRulebook.config.notEligibleAboveDti}% DTI</dd></div>
        <div><dt>Between thresholds</dt><dd>Refer for review</dd></div>
        <div><dt>Stated net income differs from verified by more than {tolerance}%</dt><dd>Refer for review</dd></div>
      </dl>
    </section>
    {errorMessageText && <p role="alert" className="notice">{errorMessageText}</p>}
    <div className="form-actions"><Link className="button secondary" to={`/applications/${applicationId}`}>Back to application</Link>
      {ready && <button className="button primary" disabled={calculation.isPending} onClick={() => calculation.mutate({ input, rulebook: activeRulebook })}>
        {calculation.isPending ? "Running eligibility..." : "Run Eligibility"}
      </button>}
    </div>
  </div>;
}
