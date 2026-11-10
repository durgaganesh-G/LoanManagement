const REQUIRED_DOCUMENTS = [
  { id: "aadhaar", label: "Aadhaar", matches: /aadhaar|aadhar|adhar|id[\s_-]?proof|identity[\s_-]?proof/i },
  { id: "payslips", label: "Payslip", matches: /pay[\s_-]?slip|salary[\s_-]?slip/i },
  { id: "bank-statements", label: "Bank statement", matches: /bank.*statement|statement.*bank/i },
];

function documentKind(document) {
  const declaredKind = parseObject(document.extractedValues).document_type;
  return REQUIRED_DOCUMENTS.some(({ id }) => id === declaredKind)
    ? declaredKind
    : REQUIRED_DOCUMENTS.find(({ matches }) => matches.test(document.originalName || ""))?.id;
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function latestDocumentsByKind(documents = []) {
  const latest = new Map();
  for (const [index, document] of documents.entries()) {
    const kind = documentKind(document);
    if (!kind) continue;
    const previous = latest.get(kind);
    const previousTime = previous?.createdAt ? new Date(previous.createdAt).getTime() : Number.NaN;
    const currentTime = document.createdAt ? new Date(document.createdAt).getTime() : Number.NaN;
    if (!previous || !Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime >= previousTime) {
      latest.set(kind, { ...document, _order: index });
    }
  }
  return latest;
}

function numberMatches(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 0.01;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function extractedValues(document) {
  const extraction = parseObject(document?.extractedValues);
  return extraction.valid ? parseObject(extraction.values) : {};
}

function verificationStatus(document) {
  const values = parseObject(document?.extractedValues);
  return parseObject(values.document_verification).status;
}

function addFailure(failures, rules, documentType, document, field, reason, rule) {
  const duplicate = failures.some((failure) =>
    failure.documentType === documentType && failure.field === field && failure.reason === reason);
  if (!duplicate) failures.push({
    documentType,
    documentId: document?.id || null,
    documentName: document?.originalName || null,
    status: document?.status || "NOT_PROCESSED",
    field: field || null,
    reason,
  });
  if (rule && !rules.includes(rule)) rules.push(rule);
}

export function assessDocumentReadiness(documents = [], income = null) {
  const latest = latestDocumentsByKind(documents);
  const failures = [];
  const rules = [];
  const unextracted = [];
  const needsSpecificReason = [];
  const missing = REQUIRED_DOCUMENTS.filter(({ id }) => !latest.has(id)).map(({ id }) => id);
  const processing = [...latest.values()].some((document) => document.status === "PROCESSING");

  for (const requirement of REQUIRED_DOCUMENTS) {
    const document = latest.get(requirement.id);
    if (!document) {
      addFailure(failures, rules, requirement.id, null, null, `${requirement.label} document is missing.`, "REQUIRED_DOCUMENTS_MISSING");
      continue;
    }
    if (document.status === "PROCESSING") continue;
    const extraction = parseObject(document.extractedValues);
    if (document.status === "UPLOADED") {
      unextracted.push(document.id);
      addFailure(failures, rules, requirement.id, document, null, `${requirement.label} has not been extracted yet.`, "DOCUMENT_VALIDATION_REQUIRES_REVIEW");
    } else if (extraction.valid !== true || document.extractionError) {
      const reason = document.extractionError || extraction.errors?.join(" ") || `${requirement.label} extraction did not pass validation.`;
      addFailure(failures, rules, requirement.id, document, null, reason, "DOCUMENT_VALIDATION_REQUIRES_REVIEW");
    } else if (document.status !== "PROCESSED") {
      // Extracted successfully but held for review: the specific reason
      // (name or income check) is added below; a generic one only if none is.
      needsSpecificReason.push({ requirement, document });
    }
    const verification = verificationStatus(document);
    if (verification !== "VERIFIED") {
      const verification = parseObject(extraction.document_verification);
      const reason = verification.reason || `${requirement.label} verification did not pass.`;
      addFailure(failures, rules, requirement.id, document, verification.field, reason, "DOCUMENT_VERIFICATION_FAILED");
    }
  }

  const identityFields = {
    aadhaar: "applicant_name",
    payslips: "employee_name",
    "bank-statements": "account_holder_name",
  };
  const identityNames = REQUIRED_DOCUMENTS.map(({ id }) => {
    const document = latest.get(id);
    const values = extractedValues(document);
    return {
      documentType: id,
      document,
      field: identityFields[id],
      name: values[identityFields[id]],
      passedOwnValidation: verificationStatus(document) === "VERIFIED" &&
        parseObject(document?.extractedValues).valid === true,
    };
  });
  if (identityNames.every(({ passedOwnValidation, name }) => passedOwnValidation && name)) {
    const canonicalName = normalizeName(identityNames[0].name);
    const mismatches = identityNames.filter(({ name }) => normalizeName(name) !== canonicalName);
    if (mismatches.length) {
      const details = identityNames.map(({ document, field, name }) =>
        `${document?.originalName || field} (${field}: ${name})`).join("; ");
      for (const { documentType, document, field } of identityNames) {
        addFailure(
          failures,
          rules,
          documentType,
          document,
          field,
          `Names differ across identity, payslip, and bank statement documents: ${details}.`,
          "CROSS_DOCUMENT_IDENTITY_MISMATCH",
        );
      }
    }
  }

  for (const id of ["payslips", "bank-statements"]) {
    const document = latest.get(id);
    if (!document || document.status === "PROCESSING") continue;
    const extraction = parseObject(document.extractedValues);
    const verification = parseObject(extraction.income_verification);
    if (verification.status !== "VERIFIED") {
      addFailure(
        failures,
        rules,
        id,
        document,
        id === "payslips" ? "net_salary" : "salary_credit_transaction",
        verification.reason || "Salary income could not be verified against the supporting documents.",
        "INCOME_VERIFICATION_FAILED",
      );
    }
  }

  const salaryDocument = latest.get("payslips");
  const bankDocument = latest.get("bank-statements");
  const salary = extractedValues(salaryDocument);
  const bank = extractedValues(bankDocument);
  const salaryGross = salary.gross_income;
  const salaryNet = salary.net_salary;
  const bankSalaryCredit = (bank.last_5_transactions || []).find((transaction) =>
    transaction.type === "CREDIT" && /\b(?:salary|payroll)\b/i.test(transaction.description));
  const grossAvailable = Number.isFinite(salaryGross);
  const netAvailable = Number.isFinite(salaryNet) && Number.isFinite(bankSalaryCredit?.amount) &&
    numberMatches(salaryNet, bankSalaryCredit.amount);

  if (!grossAvailable) {
    addFailure(
      failures, rules, "payslips", salaryDocument, "gross_income",
      "Gross income is unavailable from the payslip.",
      "MISSING_OR_UNVERIFIED_MONTHLY_GROSS_INCOME",
    );
  }
  if (!netAvailable) {
    addFailure(
      failures, rules, "payslips", salaryDocument, "net_salary",
      "Net salary is unavailable or does not match an identified salary credit in the bank statement.",
      "MISSING_OR_UNVERIFIED_MONTHLY_NET_INCOME",
    );
  }

  const financialReady = grossAvailable && netAvailable;

  for (const { requirement, document } of needsSpecificReason) {
    if (!failures.some((failure) => failure.documentType === requirement.id)) {
      addFailure(failures, rules, requirement.id, document, null, `${requirement.label} needs review.`, "DOCUMENT_VALIDATION_REQUIRES_REVIEW");
    }
  }

  // Figures the eligibility engine may use, each with the exact source line.
  // Net income counts only when the payslip net salary matches the salary
  // credited on the bank statement. Obligations count only when a document
  // explicitly states them (never summed from ordinary debits).
  const quoteFor = (values, field) => values?.evidence?.[field]?.quote ?? null;
  const sourceOf = (document) => document ? { documentId: document.id ?? null, documentName: document.originalName ?? null } : null;
  const documentedObligations = [
    { source: "payslip", document: salaryDocument, values: salary },
    { source: "bank statement", document: bankDocument, values: bank },
  ]
    .filter(({ values }) => Number.isFinite(values.monthly_obligations))
    .map(({ source, document, values }) => ({
      source,
      value: values.monthly_obligations,
      quote: quoteFor(values, "monthly_obligations"),
      ...sourceOf(document),
    }));
  const verifiedFinancials = {
    monthlyGross: grossAvailable ? salaryGross : null,
    monthlyNet: netAvailable ? salaryNet : null,
    monthlyObligations: documentedObligations.length
      ? Math.max(...documentedObligations.map(({ value }) => value))
      : null,
    obligationsSources: documentedObligations.map(({ source }) => source),
    salaryCredit: Number.isFinite(bankSalaryCredit?.amount) ? bankSalaryCredit.amount : null,
    evidence: {
      grossIncome: grossAvailable
        ? { ...sourceOf(salaryDocument), value: salaryGross, quote: quoteFor(salary, "gross_income") }
        : null,
      netSalary: netAvailable
        ? { ...sourceOf(salaryDocument), value: salaryNet, quote: quoteFor(salary, "net_salary") }
        : null,
      salaryCredit: bankSalaryCredit
        ? { ...sourceOf(bankDocument), value: bankSalaryCredit.amount, quote: bankSalaryCredit.evidence ?? null }
        : null,
      monthlyObligations: documentedObligations,
    },
  };
  const ready = missing.length === 0 && !processing && failures.length === 0 && financialReady;
  if (!ready && !processing && !rules.includes("MANUAL_REVIEW_REQUIRED")) {
    rules.push("MANUAL_REVIEW_REQUIRED");
  }

  const documentsSummary = REQUIRED_DOCUMENTS.map((requirement) => {
    const document = latest.get(requirement.id);
    if (!document) return {
      documentType: requirement.id,
      label: requirement.label,
      documentId: null,
      documentName: null,
      status: "NOT_PROCESSED",
      reason: `${requirement.label} document is missing.`,
    };
    const values = parseObject(document.extractedValues);
    const verification = parseObject(values.document_verification);
    const failure = failures.find((item) => item.documentType === requirement.id);
    return {
      documentType: requirement.id,
      label: requirement.label,
      documentId: document.id,
      documentName: document.originalName,
      status: document.status === "PROCESSING"
        ? "PROCESSING"
        : verification.status === "VERIFIED" &&
            document.status === "PROCESSED"
          ? "VERIFIED"
          : values.valid === false || document.extractionError
            ? "FAILED"
            : "NEEDS_REVIEW",
      reason: failure?.reason || verification.reason || "Required information extracted and verified.",
    };
  });
  const reason = [...new Set(failures.map(({ reason: failureReason }) => failureReason))].join(" ");

  return {
    complete: missing.length === 0,
    ready,
    financialReady,
    verifiedFinancials,
    processing,
    unextracted,
    missing,
    failures,
    documents: documentsSummary,
    rules: ready ? [] : [...new Set([...rules, "MANUAL_REVIEW_REQUIRED"])],
    reason: reason || (ready ? null : "Required document extraction and verification are incomplete."),
  };
}
