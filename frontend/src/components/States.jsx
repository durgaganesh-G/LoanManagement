export function Loading({ label = "Loading..." }) { return <p role="status" className="state">{label}</p>; }
export function ErrorState({ error, retry }) {
  return <div role="alert" className="state error"><p>{error}</p>{retry && <button className="button secondary" onClick={retry}>Try again</button>}</div>;
}
export function EmptyState({ children = "Nothing to show yet." }) { return <p className="state">{children}</p>; }
export function StatusBadge({ value }) {
  const label = value?.replaceAll("_", " ") || "Unknown";
  return <span className={`badge ${String(value).toLowerCase()}`}>{label}</span>;
}
export function DocumentStatus({ status, neutralizeReview = false, invalidDocumentType = false }) {
  const labels = {
    PROCESSING: "Extraction processing",
    PROCESSED: "Verified",
    NEEDS_REVIEW: neutralizeReview ? "Submitted" : "Needs review",
    UPLOADED: "Awaiting verification",
  };
  const label = invalidDocumentType ? "Wrong document type" : labels[status] || "Awaiting verification";
  const badgeStatus = neutralizeReview && status === "NEEDS_REVIEW" && !invalidDocumentType ? "UPLOADED" : status;
  return <div className="document-statuses" aria-label="Upload status">
    <span className={`badge document-status-${String(badgeStatus || "UPLOADED").toLowerCase()}`}>{label}</span>
  </div>;
}
