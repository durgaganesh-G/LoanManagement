import { Fragment } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";

const AUDIT_PAGE_SIZE = 100;
const FINANCIAL_FIELDS = [
  { key: "monthlyGross", aliases: ["monthlyGross", "monthly_gross"], label: "Monthly gross income", format: "money" },
  { key: "monthlyNet", aliases: ["monthlyNet", "monthly_net"], label: "Monthly net income", format: "money" },
  { key: "monthlyObligations", aliases: ["monthlyObligations", "monthly_obligations"], label: "Monthly obligations", format: "money" },
  { key: "employment", aliases: ["employment"], label: "Employment" },
  { key: "incomeSource", aliases: ["incomeSource", "income_source"], label: "Income source" },
];

const RULE_DESCRIPTIONS = {};

function parseObject(value) {
  if (!value || typeof value !== "string") return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fieldValue(values, field) {
  for (const alias of field.aliases) {
    if (Object.hasOwn(values || {}, alias)) return values[alias];
  }
  return null;
}

function displayValue(value, kind) {
  if (value === null || value === undefined || value === "") return "Not available";
  if (kind === "money" && Number.isFinite(Number(value))) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value));
  }
  if (kind === "bytes" && Number.isFinite(Number(value))) {
    const bytes = Number(value);
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let size = bytes / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(", ") : "Not available";
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "");
    return entries.length ? entries.map(([key, item]) => `${readableLabel(key)}: ${displayValue(item)}`).join("; ") : "Not available";
  }
  return String(value);
}

function sameValue(left, right) {
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (String(left).trim() !== "" && String(right).trim() !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber;
  }
  return String(left).trim() === String(right).trim();
}

function readableLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Not available";
}

function dateValue(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function asRows(value, prefix = "") {
  const object = parseObject(value);
  return Object.entries(object).flatMap(([key, item]) => {
    const label = prefix ? `${prefix} · ${readableLabel(key)}` : readableLabel(key);
    if (item && typeof item === "object" && !Array.isArray(item)) return asRows(item, label);
    if (item === null || item === undefined || item === "") return [];
    return [{ label, value: item }];
  });
}

function FinancialTable({ values }) {
  const hasValues = FINANCIAL_FIELDS.some((field) => fieldValue(values, field) !== null && fieldValue(values, field) !== undefined);
  if (!hasValues) return <p className="audit-empty">No financial values are available.</p>;
  return <div className="audit-table-wrap"><table className="audit-data-table audit-key-value-table"><thead><tr><th>Financial field</th><th>Value</th></tr></thead><tbody>
    {FINANCIAL_FIELDS.map((field) => <tr key={field.key}><th scope="row">{field.label}</th><td className={field.format === "money" ? "audit-amount" : ""}>{displayValue(fieldValue(values, field), field.format)}</td></tr>)}
  </tbody></table></div>;
}

function ChangedFields({ profile }) {
  const original = parseObject(profile?.originalValues);
  const corrected = parseObject(profile?.correctedValues);
  const changes = FINANCIAL_FIELDS.flatMap((field) => {
    const before = fieldValue(original, field);
    const after = fieldValue(corrected, field);
    return after === null || after === undefined || sameValue(before, after)
      ? []
      : [{ field, before, after }];
  });
  if (!changes.length) return <p className="audit-empty">No corrections have been recorded.</p>;
  return <div className="audit-table-wrap"><table className="audit-data-table"><thead><tr><th>Field name</th><th className="audit-amount">Original value</th><th className="audit-amount">Corrected value</th><th>Correction status</th></tr></thead><tbody>
    {changes.map(({ field, before, after }) => <tr key={field.key}><th scope="row">{field.label}</th><td className="audit-amount">{displayValue(before, field.format)}</td><td className="audit-amount">{displayValue(after, field.format)}</td><td><span className="audit-status audit-status-corrected">Corrected</span></td></tr>)}
  </tbody></table></div>;
}

function EvidenceTable({ profile, documents }) {
  const evidence = parseObject(profile?.evidence);
  const documentById = new Map((documents || []).map((document) => [document.id, document.originalName]));
  const rows = Object.entries(evidence).flatMap(([key, item]) => {
    const record = parseObject(item);
    const field = FINANCIAL_FIELDS.find(({ aliases }) => aliases.includes(key));
    const quote = record.quote ?? record.details ?? (typeof item === "string" ? item : null);
    const source = record.source ? documentById.get(record.source) || record.source : null;
    if (!quote && !source) return [];
    return [{
      type: "Extraction evidence",
      field: field?.label || readableLabel(key),
      source: source || "Not available",
      details: quote || "Not available",
    }];
  });
  for (const document of documents || []) {
    const extraction = parseObject(document.extractedValues);
    const extractedValues = extraction.valid ? parseObject(extraction.values) : {};
    for (const [key, item] of Object.entries(parseObject(extractedValues.evidence))) {
      const record = parseObject(item);
      if (!record.quote) continue;
      rows.push({
        type: "Document extraction evidence",
        field: readableLabel(key),
        source: document.originalName || "Not available",
        details: record.quote,
      });
    }
    for (const transaction of extractedValues.last_5_transactions || []) {
      if (!transaction.evidence) continue;
      rows.push({
        type: "Bank transaction evidence",
        field: `${transaction.date} · ${transaction.description} · ${transaction.type}`,
        source: document.originalName || "Not available",
        details: transaction.evidence,
      });
    }
    const verification = parseObject(extraction.income_verification);
    if (Object.keys(verification).length) {
      const sourceIds = [verification.salarySlipDocumentId, verification.bankStatementDocumentId].filter(Boolean);
      rows.push({
        type: "Income verification",
        field: "Monthly net income",
        source: sourceIds.map((id) => documentById.get(id) || id).join(", ") || document.originalName || "Not available",
        details: [verification.status, verification.reason].filter(Boolean).join(" · ") || "Not available",
      });
    }
  }
  const uniqueRows = rows.filter((row, index) => rows.findIndex((candidate) =>
    candidate.type === row.type && candidate.field === row.field && candidate.source === row.source && candidate.details === row.details) === index);
  if (!uniqueRows.length) return <p className="audit-empty">No additional evidence recorded.</p>;
  return <div className="audit-table-wrap"><table className="audit-data-table"><thead><tr><th>Evidence type</th><th>Related financial field</th><th>Source document reference</th><th>Verification details</th></tr></thead><tbody>
    {uniqueRows.map((row, index) => <tr key={`${row.type}-${row.field}-${row.source}-${index}`}><td>{row.type}</td><th scope="row">{row.field}</th><td>{row.source}</td><td>{row.details}</td></tr>)}
  </tbody></table></div>;
}

function DecisionCard({ decision, application, profile }) {
  const currentProfile = {
    monthlyNet: profile?.monthlyNet,
    monthlyObligations: profile?.monthlyObligations,
  };
  const monthlyNet = currentProfile.monthlyNet;
  const obligations = currentProfile.monthlyObligations;
  const rules = Array.isArray(decision.rulesTriggered) ? decision.rulesTriggered : [];
  const statusClass = decision.outcome === "ELIGIBLE" ? "audit-status-eligible"
    : decision.outcome === "REFER" ? "audit-status-refer"
      : ["NOT_ELIGIBLE", "DECLINE", "DECLINED"].includes(decision.outcome) ? "audit-status-declined" : "audit-status-neutral";
  return <details className="audit-decision-card">
    <summary className="audit-accordion-summary">
      <div className="audit-decision-heading"><div><p className="eyebrow">RECORDED DECISION</p><h3>{readableLabel(decision.outcome)}</h3></div><span className={`audit-status ${statusClass}`}>{readableLabel(decision.outcome)}</span></div>
      <span className="audit-accordion-caption">{dateValue(decision.createdAt)}</span>
    </summary>
    <div className="audit-accordion-content">
      <div className="audit-facts-grid">
        <div><span>Application ID</span><b>{application?.id || "Not available"}</b></div>
        <div><span>Loan amount</span><b className="audit-amount">{displayValue(application?.loanAmount, "money")}</b></div>
        <div><span>Monthly net income · current profile</span><b className="audit-amount">{displayValue(monthlyNet, "money")}</b></div>
        <div><span>Monthly obligations · current profile</span><b className="audit-amount">{displayValue(obligations, "money")}</b></div>
        <div><span>DTI</span><b>{decision.dtiPercent == null ? "Not available" : `${Number(decision.dtiPercent).toFixed(2)}%`}</b></div>
        <div><span>Rulebook version</span><b>{decision.rulebookVersion || "Not available"}</b></div>
        <div><span>Decision timestamp</span><b>{dateValue(decision.createdAt)}</b></div>
        <div><span>Affordability · current profile</span><b className="audit-amount">{monthlyNet == null || obligations == null ? "Not available" : displayValue(Number(monthlyNet) - Number(obligations), "money")}</b></div>
      </div>
      <p className="audit-data-note">Financial amounts above are the current profile; a per-decision financial snapshot is not available in the recorded data.</p>
      <h4>Triggered eligibility rules</h4>
      {rules.length ? <div className="audit-table-wrap"><table className="audit-data-table"><thead><tr><th>Rule ID</th><th>Rule description</th><th>Result</th></tr></thead><tbody>
        {rules.map((rule) => <tr key={rule}><th scope="row">{rule}</th><td>{RULE_DESCRIPTIONS[rule] || rule}</td><td><span className="audit-status audit-status-neutral">Triggered</span></td></tr>)}
      </tbody></table></div> : <p className="audit-empty">No triggered rules are recorded for this decision.</p>}
      <h4>Decision explanation</h4>
      <p className="audit-explanation">{decision.explanation || "No decision explanation is available."}</p>
    </div>
  </details>;
}

function AuditEventDetails({ event, application }) {
  const details = parseObject(event.details);
  const documentId = details.documentId;
  const document = (application?.documents || []).find((item) => item.id === documentId);
  const detailRows = [];
  if (documentId) detailRows.push(["Document ID", documentId]);
  if (document?.originalName) detailRows.push(["Document type / file", document.originalName]);
  if (document?.mimeType) detailRows.push(["File type", document.mimeType]);
  if (details.sizeBytes != null || document?.sizeBytes != null) {
    detailRows.push(["File size", displayValue(details.sizeBytes ?? document.sizeBytes, "bytes")]);
  }
  if (details.status) detailRows.push(["Workflow status", readableLabel(details.status)]);
  if (details.outcome) detailRows.push(["Eligibility outcome", readableLabel(details.outcome)]);
  if (details.rulebookVersion) detailRows.push(["Rulebook version", details.rulebookVersion]);
  if (details.code) detailRows.push(["Status code", details.code]);
  if (details.incomeVerification) {
    const verification = parseObject(details.incomeVerification);
    if (verification.status) detailRows.push(["Income verification", readableLabel(verification.status)]);
    if (verification.reason) detailRows.push(["Verification reason", verification.reason]);
    if (verification.salarySlipDocumentId) detailRows.push(["Salary slip reference", verification.salarySlipDocumentId]);
    if (verification.bankStatementDocumentId) detailRows.push(["Bank statement reference", verification.bankStatementDocumentId]);
  }
  if (Array.isArray(details.differences) && details.differences.length) {
    detailRows.push(["Cross-document differences", details.differences.map((item) => typeof item === "string" ? item : readableLabel(item.field || item.type)).join("; ")]);
  }
  for (const { label, value } of asRows(details)) {
    if (detailRows.some(([existingLabel]) => existingLabel === label)) continue;
    detailRows.push([label, displayValue(value)]);
  }
  return detailRows.length ? <div className="audit-event-details"><dl>{detailRows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl></div> : <p className="audit-empty">No additional event details recorded.</p>;
}

function AuditTimeline({ events, application }) {
  const chronologicalEvents = [...events].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
  if (!chronologicalEvents.length) return <EmptyState>No audit events recorded.</EmptyState>;
  return <div className="audit-timeline">{chronologicalEvents.map((event) => {
    const details = parseObject(event.details);
    const outcome = details.outcome;
    const status = details.status;
    const actor = event.actorId || (event.action.startsWith("AI_") ? "AI workflow" : "Not available");
    return <div className="audit-timeline-event" key={event.id}>
      <span className="audit-timeline-marker" aria-hidden="true" />
      <details className="audit-timeline-card">
        <summary className="audit-accordion-summary audit-event-summary">
          <div className="audit-event-heading"><h3>{readableLabel(event.action)}</h3><time>{dateValue(event.createdAt)}</time></div>
          <span className="audit-accordion-caption">View event details</span>
        </summary>
        <div className="audit-accordion-content">
          <div className="audit-event-meta"><span>Actor / source: {actor}</span>{status && <span className="audit-status audit-status-neutral">{readableLabel(status)}</span>}{outcome && <span className={`audit-status ${outcome === "ELIGIBLE" || outcome === "APPROVED" ? "audit-status-eligible" : outcome === "REFER" ? "audit-status-refer" : outcome === "DECLINED" || outcome === "NOT_ELIGIBLE" ? "audit-status-declined" : "audit-status-neutral"}`}>{readableLabel(outcome)}</span>}</div>
          <AuditEventDetails event={event} application={application} />
          {Object.keys(details).length > 0 && <details className="audit-technical-details"><summary>View technical details</summary><pre>{JSON.stringify(details, null, 2)}</pre></details>}
        </div>
      </details>
    </div>;
  })}</div>;
}

export default function AuditPage() {
  const { applicationId } = useParams();
  const { data: application, isLoading: applicationLoading, error: applicationError, refetch: refetchApplication } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
  });
  const { data, isLoading: auditLoading, error: auditError, refetch: refetchAudit } = useQuery({
    queryKey: ["audit", applicationId],
    queryFn: async () => {
      const firstPage = (await api.get(`/applications/${applicationId}/audit`, { params: { page: 1, limit: AUDIT_PAGE_SIZE } })).data;
      const pageCount = Math.ceil(firstPage.total / AUDIT_PAGE_SIZE);
      if (pageCount <= 1) return firstPage;
      const laterPages = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) =>
        api.get(`/applications/${applicationId}/audit`, { params: { page: index + 2, limit: AUDIT_PAGE_SIZE } })));
      return { ...firstPage, items: [firstPage.items, ...laterPages.map(({ data: page }) => page.items)].flat() };
    },
  });
  if (applicationLoading || auditLoading) return <Loading />;
  if (applicationError || auditError) return <ErrorState
    error={errorMessage(applicationError || auditError)}
    retry={() => Promise.all([refetchApplication(), refetchAudit()])}
  />;

  const profile = data.financialProfile;
  const originalValues = parseObject(profile?.originalValues);
  const decisions = [...(data.decisions || [])].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
  const reviews = data.reviews || [];
  const documents = application.documents || data.documents || [];

  return <div className="audit-page">
    <div className="breadcrumb"><Link to={`/applications/${applicationId}`}>{application.applicationNo || data.applicationNo || "Application"}</Link><span>/</span><span>Audit history</span></div>
    <div className="page-heading"><div><p className="eyebrow">AUDIT HISTORY · READ ONLY</p><h1>Application audit history</h1><p className="muted">Financial evidence, eligibility decisions, reviews, and application events.</p></div></div>

    <section className="panel audit-application-summary">
      <div className="panel-heading"><div><p className="eyebrow">APPLICATION INFORMATION</p><h2>{application.applicationNo || data.applicationNo || "Application"}</h2></div><StatusBadge value={application.status} /></div>
      <div className="audit-facts-grid">
        <div><span>Applicant name</span><b>{application.applicant?.fullName || "Not available"}</b></div>
        <div><span>Loan amount</span><b className="audit-amount">{displayValue(application.loanAmount, "money")}</b></div>
        <div><span>Application status</span><b>{readableLabel(application.status)}</b></div>
      </div>
    </section>

    <section className="panel audit-section">
      <div className="panel-heading"><div><p className="eyebrow">SECTION 1</p><h2>Financial profile</h2><p className="muted">Extracted, current, and corrected profile data with available source evidence.</p></div></div>
      {profile ? <>
        <div className="audit-subsection"><h3>Current values</h3><FinancialTable values={profile} /></div>
        <div className="audit-subsection"><h3>Original extraction</h3><FinancialTable values={originalValues} /></div>
        <div className="audit-subsection"><h3>Corrected values</h3><ChangedFields profile={profile} /></div>
        <div className="audit-subsection"><h3>Evidence</h3><EvidenceTable profile={profile} documents={documents} /></div>
      </> : <EmptyState>No financial profile is stored.</EmptyState>}
    </section>

    <section className="panel audit-section">
      <div className="panel-heading"><div><p className="eyebrow">SECTION 2</p><h2>Decisions and reviews</h2><p className="muted">All recorded automated decisions and human reviews are preserved below.</p></div></div>
      {decisions.length ? <div className="audit-decision-list">{decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} application={application} profile={profile} />)}</div> : <EmptyState>No decision recorded.</EmptyState>}
      {reviews.length > 0 && <div className="audit-subsection"><h3>Officer reviews</h3><div className="audit-review-list">{reviews.map((review) => <details className="audit-review-card" key={review.id}>
        <summary className="audit-accordion-summary">
          <div className="audit-decision-heading"><h4>{readableLabel(review.outcome)}</h4><span className={`audit-status ${review.outcome === "APPROVED" ? "audit-status-eligible" : review.outcome === "DECLINED" ? "audit-status-declined" : "audit-status-neutral"}`}>{readableLabel(review.outcome)}</span></div>
          <span className="audit-accordion-caption">{dateValue(review.createdAt)}</span>
        </summary>
        <div className="audit-accordion-content">
          <dl><dt>Review timestamp</dt><dd>{dateValue(review.createdAt)}</dd><dt>Officer score</dt><dd>{review.score == null ? "Not available" : `${review.score} / 100`}</dd><dt>Remarks</dt><dd>{review.remarks || "Not available"}</dd></dl>
        </div>
      </details>)}</div></div>}
    </section>

    <section className="panel audit-section">
      <div className="panel-heading"><div><p className="eyebrow">SECTION 3</p><h2>Application activity</h2><p className="muted">{data.total ?? data.items?.length ?? 0} audit events in chronological order.</p></div></div>
      <AuditTimeline events={data.items || []} application={{ ...application, documents }} />
    </section>
  </div>;
}
