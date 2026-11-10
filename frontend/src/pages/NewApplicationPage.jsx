import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import useIdempotencyKey from "../hooks/useIdempotencyKey";

export default function NewApplicationPage() {
  const navigate = useNavigate();
  const idempotencyKey = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", employment: "", loanAmount: "", loanTermMonths: "36", monthlyGross: "", monthlyNet: "", monthlyObligations: "" });
  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const payload = {
        applicant: { fullName: form.fullName, email: form.email, ...(form.phone && { phone: form.phone }), ...(form.employment && { employment: form.employment }) },
        loanAmount: Number(form.loanAmount), loanTermMonths: Number(form.loanTermMonths),
        ...(form.monthlyGross !== "" || form.monthlyNet !== "" || form.monthlyObligations !== "" ? {
          financial: {
            ...(form.monthlyGross !== "" && { monthlyGross: Number(form.monthlyGross) }),
            ...(form.monthlyNet !== "" && { monthlyNet: Number(form.monthlyNet) }),
            ...(form.monthlyObligations !== "" && { monthlyObligations: Number(form.monthlyObligations) }),
          },
        } : {}),
      };
      const { data } = await api.post("/applications", payload, { headers: { "Idempotency-Key": idempotencyKey("application", payload) } });
      navigate(`/applications/${data.id}`);
    } catch (issue) { setError(errorMessage(issue)); } finally { setBusy(false); }
  }
  return <div className="new-application-page"><div className="page-heading"><div><p className="eyebrow">APPLICATIONS / NEW REQUEST</p><h1>Start a loan application</h1><p className="muted">A few details to get the application underway.</p></div><div className="form-step-indicator"><span className="step-active">01</span><i /><span>02</span><i /><span>03</span><small>Application <b>·</b> Documents <b>·</b> Review</small></div></div>
    <form className="panel form-stack application-form" onSubmit={submit}>
      <div className="form-section-heading"><span className="section-index">01</span><div><h2>Applicant details</h2><p>Who is applying for this loan?</p></div></div><div className="form-grid">
        <label>Full name<input required maxLength="120" value={form.fullName} onChange={(e) => update("fullName", e.target.value)} /></label>
        <label>Email address<input type="email" required value={form.email} onChange={(e) => update("email", e.target.value)} /></label>
        <label>Phone number <span className="muted">(optional)</span><input type="tel" value={form.phone} onChange={(e) => update("phone", e.target.value)} /></label>
        <label>Employment <span className="muted">(optional)</span><input value={form.employment} onChange={(e) => update("employment", e.target.value)} /></label>
      </div>
      <hr /><div className="form-section-heading"><span className="section-index">02</span><div><h2>Loan request</h2><p>Set the requested amount and repayment term.</p></div></div><div className="form-grid">
        <label>Requested amount ($)<input type="number" min="1" max="100000000" step="0.01" required value={form.loanAmount} onChange={(e) => update("loanAmount", e.target.value)} /></label>
        <label>Loan term (months)<input type="number" min="1" max="600" required value={form.loanTermMonths} onChange={(e) => update("loanTermMonths", e.target.value)} /></label>
      </div>
      <div className="form-section-heading financial-heading"><span className="section-index">03</span><div><h2>Financial details <span>Optional</span></h2><p>Your stated figures are checked against your documents. Eligibility is calculated from the figures verified in your payslip and bank statement; if your stated net income does not match, a loan officer reviews the application.</p></div></div><div className="form-grid">
        <label>Monthly gross income ($) <span className="muted">(optional)</span><input type="number" min="0" step="0.01" value={form.monthlyGross} onChange={(e) => update("monthlyGross", e.target.value)} /></label>
        <label>Monthly net income ($) <span className="muted">(checked against your payslip)</span><input type="number" min="0" step="0.01" value={form.monthlyNet} onChange={(e) => update("monthlyNet", e.target.value)} /></label>
        <label>Existing monthly obligations ($) <span className="muted">(optional)</span><input type="number" min="0" step="0.01" value={form.monthlyObligations} onChange={(e) => update("monthlyObligations", e.target.value)} /></label>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={() => navigate("/applications")}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Creating..." : "Create application →"}</button></div>
    </form>
  </div>;
}
