import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";
import { getApplication } from "./applicationService.js";
import { runEligibility } from "./aiClient.js";
import { beginOperation, cancelOperation, completeOperation } from "./idempotencyService.js";
import { activeRulebook } from "./rulebookService.js";
import { assessDocumentReadiness } from "./documentReadiness.js";

export async function getDecision(user, applicationId) {
  await getApplication(user, applicationId);
  const decision = await prisma.decision.findFirst({ where: { applicationId }, orderBy: { createdAt: "desc" } });
  if (!decision) throw new AppError(404, "DECISION_NOT_FOUND", "No eligibility decision is available yet");
  const traces = await prisma.auditLog.findMany({
    where: { applicationId, action: { in: ["ELIGIBILITY_CALCULATED", "MANUAL_REVIEW_REFER_RECORDED"] } },
    orderBy: { createdAt: "desc" },
  });
  const decisionTrace = traces.map((entry) => {
    try {
      return JSON.parse(entry.details);
    } catch {
      return {};
    }
  }).find((details) => details.decisionId === decision.id);
  return {
    ...decision,
    rulesTriggered: JSON.parse(decision.rulesTriggered),
    financialSnapshot: decisionTrace?.financialSnapshot || null,
  };
}

export async function listReferrals(query) {
  const where = { status: "REFER", reviews: { none: {} } };
  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where, include: { applicant: true, income: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 }, reviews: { orderBy: { createdAt: "desc" }, take: 1 } },
      skip: (query.page - 1) * query.limit, take: query.limit, orderBy: { createdAt: "asc" },
    }),
    prisma.application.count({ where }),
  ]);
  return { items, page: query.page, limit: query.limit, total };
}

export async function reviewReferral(user, id, { outcome, remarks, score }, idempotencyKey) {
  const operation = await beginOperation(user.sub, idempotencyKey, `REVIEW:${id}`, { outcome, remarks, score });
  if (operation.replayId) {
    return { review: await prisma.review.findUnique({ where: { id: operation.replayId } }), replayed: true };
  }
  try {
    const review = await prisma.$transaction(async (tx) => {
      const application = await tx.application.findUnique({ where: { id } });
      if (!application) throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
      if (application.status !== "REFER") throw new AppError(409, "NOT_REFERRED", "Only referred applications can be reviewed");
      const record = await tx.review.create({ data: { applicationId: id, officerId: user.sub, outcome, remarks, score } });
      await tx.application.update({ where: { id }, data: { status: outcome } });
      await tx.auditLog.create({
        data: { applicationId: id, actorId: user.sub, action: "OFFICER_REVIEW_RECORDED", details: JSON.stringify({ reviewId: record.id, outcome, remarks, score }) },
      });
      await completeOperation(operation.recordId, record.id, tx);
      return record;
    });
    return { review, replayed: false };
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }
}

export async function getAudit(user, applicationId, query) {
  const application = await getApplication(user, applicationId);
  const [items, total, income, decisions, reviews, documents] = await Promise.all([
    prisma.auditLog.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.auditLog.count({ where: { applicationId } }),
    prisma.income.findUnique({ where: { applicationId } }),
    prisma.decision.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" } }),
    prisma.review.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" } }),
    prisma.document.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, select: { id: true, originalName: true, status: true, extractedValues: true, extractionError: true, createdAt: true } }),
  ]);
  return {
    applicationId,
    applicationNo: application.applicationNo,
    financialProfile: income ? {
      monthlyGross: income.monthlyGross,
      monthlyNet: income.monthlyNet,
      monthlyObligations: income.monthlyObligations,
      employment: income.employment,
      incomeSource: income.incomeSource,
      evidence: income.evidence ? JSON.parse(income.evidence) : null,
      originalValues: income.originalValues ? JSON.parse(income.originalValues) : null,
      correctedValues: income.correctedValues ? JSON.parse(income.correctedValues) : null,
      updatedAt: income.updatedAt,
    } : null,
    documents: documents.map((document) => ({
      ...document,
      extractedValues: document.extractedValues ? JSON.parse(document.extractedValues) : null,
    })),
    decisions: decisions.map((decision) => ({
      ...decision,
      rulesTriggered: JSON.parse(decision.rulesTriggered),
    })),
    reviews,
    items,
    page: query.page,
    limit: query.limit,
    total,
  };
}

const NET_INCOME_SOURCE = "payslip net salary, matched to the salary credit on the bank statement";

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// Obligations: what the documents explicitly state, or what the applicant
// declared. When both exist the higher amount is used (conservative).
function chooseObligations(verified, declared) {
  const documented = finiteOrNull(verified.monthlyObligations);
  const stated = finiteOrNull(declared.monthlyObligations);
  const documentSource = `stated on the ${verified.obligationsSources.join(" and ")}`;
  if (documented != null && stated != null) {
    return stated > documented
      ? { value: stated, source: "declared on the application (higher than the documented amount)" }
      : { value: documented, source: documentSource };
  }
  if (documented != null) return { value: documented, source: documentSource };
  if (stated != null) return { value: stated, source: "declared on the application" };
  return { value: null, source: null };
}

// Eligibility is decided only from document-verified figures:
//   upload -> extraction (LLM + source checks) -> verified profile
//   -> DTI + rulebook (deterministic) -> explanation -> referral -> audit.
// Missing or unprocessed documents block the decision; documents that fail
// verification are referred to a loan officer instead of being decided.
export async function rerunEligibility(user, applicationId, idempotencyKey) {
  const application = await getApplication(user, applicationId);
  const readiness = application.workflow;
  if (!application.documents.length || readiness.missing.length) {
    throw new AppError(409, "REQUIRED_DOCUMENTS_MISSING", "Upload the ID proof, payslip, and bank statement before running eligibility");
  }
  if (readiness.processing) {
    throw new AppError(409, "DOCUMENT_PROCESSING", "Wait for document extraction to finish before running eligibility");
  }
  if (readiness.unextracted.length) {
    throw new AppError(409, "DOCUMENT_EXTRACTION_REQUIRED", "Extract the uploaded documents before running eligibility");
  }
  if (!readiness.ready) {
    return recordManualReview(user, applicationId, idempotencyKey);
  }

  const rulebook = await activeRulebook();
  const verified = readiness.verifiedFinancials;
  const declared = application.applicantProvidedFinancials || {};
  const obligations = chooseObligations(verified, declared);
  const input = {
    monthlyGross: verified.monthlyGross,
    monthlyNet: verified.monthlyNet,
    monthlyObligations: obligations.value,
    obligationsSource: obligations.source,
    declaredMonthlyNet: finiteOrNull(declared.monthlyNet),
    declaredMonthlyObligations: finiteOrNull(declared.monthlyObligations),
    loanAmount: application.loanAmount,
    loanTermMonths: application.loanTermMonths,
    rulebookVersion: rulebook.version,
    rulebookConfig: rulebook.config,
  };
  const operation = await beginOperation(user.sub, idempotencyKey, `DECISION:${applicationId}`, input);
  if (operation.replayId) {
    const previous = await prisma.decision.findUnique({ where: { id: operation.replayId } });
    if (!previous) throw new AppError(404, "DECISION_NOT_FOUND", "The previously calculated decision is unavailable");
    return { ...previous, rulesTriggered: JSON.parse(previous.rulesTriggered) };
  }
  try {
    const decision = await runEligibility({
      monthly_gross: input.monthlyGross,
      monthly_net: input.monthlyNet,
      monthly_obligations: input.monthlyObligations,
      loan_amount: input.loanAmount,
      rulebook_version: input.rulebookVersion,
      rulebook_config: input.rulebookConfig,
      declared_monthly_net: input.declaredMonthlyNet,
      net_income_source: NET_INCOME_SOURCE,
      obligations_source: input.obligationsSource,
      // Grounded LLM summary on top of the deterministic explanation; set
      // AI_LLM_EXPLANATION=false to use only the deterministic text.
      explain_with_llm: process.env.AI_LLM_EXPLANATION !== "false",
    });
    const snapshot = {
      loanAmount: input.loanAmount,
      loanTermMonths: input.loanTermMonths,
      monthlyGross: input.monthlyGross,
      monthlyNet: input.monthlyNet,
      monthlyObligations: input.monthlyObligations,
      netIncomeSource: NET_INCOME_SOURCE,
      obligationsSource: input.obligationsSource,
      declaredMonthlyNet: input.declaredMonthlyNet,
      declaredMonthlyObligations: input.declaredMonthlyObligations,
      financialInputSource: "VERIFIED_DOCUMENTS",
      verifiedFinancialInputs: true,
      evidence: verified.evidence,
      documentSummary: readiness.documents,
      explanationSource: decision.explanation_source || "template",
    };
    const record = await prisma.$transaction(async (tx) => {
      const saved = await tx.decision.create({
        data: {
          applicationId, outcome: decision.outcome, dtiPercent: decision.dti_percent,
          rulesTriggered: JSON.stringify(decision.rules_triggered),
          rulebookVersion: decision.rulebook_version, explanation: decision.explanation,
        },
      });
      await tx.application.update({ where: { id: applicationId }, data: { status: decision.outcome } });
      await tx.auditLog.create({
        data: {
          applicationId,
          actorId: user.sub,
          action: "ELIGIBILITY_CALCULATED",
          details: JSON.stringify({
            decisionId: saved.id,
            financialSnapshot: snapshot,
            outcome: decision.outcome,
            rulesTriggered: decision.rules_triggered,
            rulebookVersion: decision.rulebook_version,
          }),
        },
      });
      await completeOperation(operation.recordId, saved.id, tx);
      return saved;
    });
    return { ...record, rulesTriggered: decision.rules_triggered, financialSnapshot: snapshot };
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }
}

export async function recordManualReview(user, applicationId, idempotencyKey) {
  const application = await getApplication(user, applicationId);
  const readiness = assessDocumentReadiness(application.documents, application.income);
  if (readiness.processing) {
    throw new AppError(409, "DOCUMENT_PROCESSING", "Wait for all required document extraction to finish before requesting a decision explanation");
  }
  if (readiness.unextracted.length) {
    throw new AppError(409, "DOCUMENT_EXTRACTION_REQUIRED", "Extract all uploaded documents before requesting a decision explanation");
  }
  if (readiness.ready) {
    throw new AppError(409, "MANUAL_REVIEW_NOT_REQUIRED", "All required documents and financial fields are verified; proceed to eligibility");
  }
  if (!application.documents.length) {
    throw new AppError(409, "DOCUMENTS_NOT_UPLOADED", "Upload at least one supporting document before requesting manual review");
  }

  const rulebook = await activeRulebook();
  const reason = readiness.reason || "Required document extraction and verification are incomplete.";
  const verified = readiness.verifiedFinancials;
  const obligations = chooseObligations(verified, application.applicantProvidedFinancials || {});
  const input = {
    applicationId,
    rulebookVersion: rulebook.version,
    failures: readiness.failures,
    monthlyGross: verified.monthlyGross,
    monthlyNet: verified.monthlyNet,
    monthlyObligations: obligations.value,
    loanAmount: application.loanAmount,
    loanTermMonths: application.loanTermMonths,
  };
  const operation = await beginOperation(user.sub, idempotencyKey, `MANUAL_REVIEW:${applicationId}`, input);
  if (operation.replayId) {
    const previous = await prisma.decision.findUnique({ where: { id: operation.replayId } });
    if (!previous) throw new AppError(404, "DECISION_NOT_FOUND", "The previously recorded manual-review decision is unavailable");
    return { ...previous, rulesTriggered: JSON.parse(previous.rulesTriggered), replayed: true };
  }

  try {
    let dtiPercent = null;
    let rulesTriggered = readiness.rules;
    if (readiness.financialReady) {
      const calculated = await runEligibility({
        monthly_gross: input.monthlyGross,
        monthly_net: input.monthlyNet,
        monthly_obligations: input.monthlyObligations,
        loan_amount: input.loanAmount,
        rulebook_version: rulebook.version,
        rulebook_config: rulebook.config,
        manual_review_reason: reason,
      });
      dtiPercent = calculated.dti_percent;
      rulesTriggered = [...new Set([...calculated.rules_triggered, ...readiness.rules, "MANUAL_REVIEW_REQUIRED"])];
    }

    // For the applicant, show the first (root-cause) reason per document; the
    // full list of failed checks stays in the decision record for the officer.
    const labels = { aadhaar: "ID proof", payslips: "Payslip", "bank-statements": "Bank statement" };
    const firstReasonPerDocument = new Map();
    for (const failure of readiness.failures) {
      if (!firstReasonPerDocument.has(failure.documentType)) {
        firstReasonPerDocument.set(failure.documentType, `- ${labels[failure.documentType] || "Document"}: ${failure.reason}`);
      }
    }
    const reasons = [...firstReasonPerDocument.values()];
    const explanation = [
      `Your application has been referred to a loan officer for manual review under rulebook ${rulebook.version}.`,
      readiness.financialReady
        ? "Your income could be verified, but other document checks did not pass, so no automated eligibility decision was made."
        : "Your income could not be verified from the documents, so no automated eligibility decision was made and no DTI was calculated from unverified figures.",
      "What needs attention:",
      ...(reasons.length ? reasons : [`- ${reason}`]),
      "You can correct and re-upload the documents, or a loan officer will review the application.",
    ].join("\n");
    const snapshot = {
      loanAmount: input.loanAmount,
      loanTermMonths: input.loanTermMonths,
      monthlyGross: input.monthlyGross,
      monthlyNet: input.monthlyNet,
      monthlyObligations: input.monthlyObligations,
      verifiedFinancialInputs: readiness.financialReady,
      documentSummary: readiness.documents,
      failedFields: readiness.failures,
    };
    const record = await prisma.$transaction(async (tx) => {
      const saved = await tx.decision.create({
        data: {
          applicationId,
          outcome: "REFER",
          dtiPercent,
          rulesTriggered: JSON.stringify(rulesTriggered),
          rulebookVersion: rulebook.version,
          explanation,
        },
      });
      await tx.application.update({ where: { id: applicationId }, data: { status: "REFER" } });
      await tx.auditLog.create({
        data: {
          applicationId,
          actorId: user.sub,
          action: "MANUAL_REVIEW_REFER_RECORDED",
          details: JSON.stringify({
            decisionId: saved.id,
            reason,
            failures: readiness.failures,
            rulesTriggered,
            rulebookVersion: rulebook.version,
            financialSnapshot: snapshot,
          }),
        },
      });
      await completeOperation(operation.recordId, saved.id, tx);
      return saved;
    });
    return {
      ...record,
      rulesTriggered,
      financialSnapshot: snapshot,
      reviewStatus: "MANUAL REVIEW REQUIRED",
    };
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }
}
