const REQUIRED_DOCUMENTS = [
  { id: "aadhaar", matches: /aadhaar|aadhar|adhar|id[\s_-]?proof|identity[\s_-]?proof/i },
  { id: "payslips", matches: /pay[\s_-]?slips?|salary[\s_-]?slips?/i },
  { id: "bank-statements", matches: /bank.*statement|statement.*bank/i },
];

function documentValues(document) {
  if (!document.extractedValues) return {};
  if (typeof document.extractedValues !== "string") return document.extractedValues;
  try {
    return JSON.parse(document.extractedValues);
  } catch {
    return {};
  }
}

function documentKind(document) {
  const values = documentValues(document);
  return values.document_type || REQUIRED_DOCUMENTS.find(({ matches }) => matches.test(document.originalName || ""))?.id;
}

export function latestRequiredDocuments(documents = []) {
  const latest = new Map();
  const orderedDocuments = [...documents].sort((left, right) => {
    const leftDate = left.createdAt ? new Date(left.createdAt).getTime() : Number.NaN;
    const rightDate = right.createdAt ? new Date(right.createdAt).getTime() : Number.NaN;
    return Number.isFinite(leftDate) && Number.isFinite(rightDate) ? leftDate - rightDate : 0;
  });
  for (const document of orderedDocuments) {
    const kind = documentKind(document);
    if (kind && REQUIRED_DOCUMENTS.some(({ id }) => id === kind)) latest.set(kind, document);
  }
  return latest;
}

export function documentsForManualReview(documents = []) {
  const latestRequired = latestRequiredDocuments(documents);
  if (latestRequired.size === REQUIRED_DOCUMENTS.length) return [...latestRequired.values()];
  return [...documents]
    .sort((left, right) => {
      const leftDate = left.createdAt ? new Date(left.createdAt).getTime() : Number.NaN;
      const rightDate = right.createdAt ? new Date(right.createdAt).getTime() : Number.NaN;
      if (!Number.isFinite(leftDate) || !Number.isFinite(rightDate)) return 0;
      return rightDate - leftDate;
    })
    .slice(0, REQUIRED_DOCUMENTS.length);
}

export function requiredDocumentsReady(documents = []) {
  const latest = latestRequiredDocuments(documents);
  if (REQUIRED_DOCUMENTS.some(({ id }) => !latest.has(id))) return false;
  const latestDocuments = [...latest.entries()];
  if (latestDocuments.some(([id, document]) => id === "aadhaar"
    ? !["UPLOADED", "PROCESSED"].includes(document.status)
    : document.status !== "PROCESSED")) return false;
  return ["payslips", "bank-statements"].some((id) =>
    documentValues(latest.get(id)).income_verification?.status === "VERIFIED");
}

export function hasManualDocumentReview(decision) {
  if (decision?.outcome !== "REFER") return false;
  let rules = decision.rulesTriggered;
  if (typeof rules === "string") {
    try {
      rules = JSON.parse(rules);
    } catch {
      return false;
    }
  }
  return Array.isArray(rules) && rules.includes("MANUAL_REVIEW_REQUIRED");
}
