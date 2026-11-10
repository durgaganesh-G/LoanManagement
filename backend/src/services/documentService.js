import { readFile, unlink, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";
import { getApplication } from "./applicationService.js";
import { runWorkflow, validateDocument } from "./aiClient.js";
import { beginOperation, cancelOperation, completeOperation } from "./idempotencyService.js";
import { activeRulebook } from "./rulebookService.js";
import { logger } from "../utils/logger.js";
import { assessDocumentReadiness } from "./documentReadiness.js";

const documentProcessingQueues = new Map();
const REQUIRED_DOCUMENT_TYPES = ["aadhaar", "payslips", "bank-statements"];
const DOCUMENT_REJECTED_MESSAGE = "This PDF is not an ID proof, payslip, or bank statement. Only these three documents are accepted.";

function scheduleDocumentWorkflows(args) {
  const previous = documentProcessingQueues.get(args.applicationId) || Promise.resolve();
  const task = previous
    .catch((error) => logger.error({ err: error, applicationId: args.applicationId }, "Previous document workflow failed"))
    .then(async () => {
      for (const document of args.documents) {
        try {
          await processDocumentWorkflow({
            ...args,
            document,
            contents: args.contentsById.get(document.id),
          });
        } catch (error) {
          logger.error({ err: error, documentId: document.id }, "Document workflow failed in background");
        }
      }
      await completeOperation(args.operationId, args.applicationId);
    })
    .catch(async (error) => {
      await cancelOperation(args.operationId);
      logger.error({ err: error, applicationId: args.applicationId }, "Application document extraction failed");
    })
    .finally(() => {
      if (documentProcessingQueues.get(args.applicationId) === task) {
        documentProcessingQueues.delete(args.applicationId);
      }
    });
  documentProcessingQueues.set(args.applicationId, task);
}

function requiredDocumentKind(document) {
  const filename = typeof document === "string" ? document : document?.originalName;
  const declaredKind = typeof document === "string" ? null : parseDocumentType(document?.extractedValues);
  if (declaredKind) return declaredKind;
  if (/aadhaar|aadhar|adhar|id[\s_-]?proof|identity[\s_-]?proof/i.test(filename || "")) return "aadhaar";
  if (/pay[\s_-]?slip|salary[\s_-]?slip/i.test(filename || "")) return "payslips";
  if (/bank.*statement|statement.*bank/i.test(filename || "")) return "bank-statements";
  return null;
}

function parseDocumentType(value) {
  if (!value) return null;
  try {
    const extracted = typeof value === "string" ? JSON.parse(value) : value;
    return ["aadhaar", "payslips", "bank-statements"].includes(extracted?.document_type)
      ? extracted.document_type
      : null;
  } catch {
    return null;
  }
}

function matchesApplicantName(extractedName, applicantName) {
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return Boolean(normalize(extractedName) && normalize(extractedName) === normalize(applicantName));
}

function compareDocumentNames(documents) {
  const documentTypes = ["aadhaar", "payslips", "bank-statements"];
  const namesByType = new Map(documentTypes.map((type) => [type, []]));
  const fields = {
    aadhaar: "applicant_name",
    payslips: "employee_name",
    "bank-statements": "account_holder_name",
  };
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

  for (const document of documents) {
    const extracted = parseDocumentTypeValues(document.extractedValues);
    if (!extracted?.valid || extracted.document_verification?.status !== "VERIFIED") continue;
    const kind = extracted.document_type;
    const field = fields[kind];
    const name = extracted.values?.[field];
    if (!field || !name || !namesByType.has(kind)) continue;
    namesByType.get(kind).push({ name, document });
  }

  const missingTypes = documentTypes.filter((type) => !namesByType.get(type).length);
  if (missingTypes.length) {
    return {
      status: "PENDING",
      reason: `Cross-document identity comparison is pending ${missingTypes.join(", ")} verification.`,
      documentIds: [...namesByType.values()].flat().map(({ document }) => document.id).filter(Boolean),
    };
  }

  const entries = [...namesByType.entries()].flatMap(([type, names]) =>
    names.map((entry) => ({ ...entry, type, field: fields[type] })));
  const expectedName = normalize(entries[0].name);
  const mismatches = entries.filter(({ name }) => normalize(name) !== expectedName);
  if (mismatches.length) {
    const details = entries.map(({ name, document, field }) =>
      `${document.originalName || "Document"} (${field}: ${name})`);
    return {
      status: "MISMATCH",
      reason: `Names differ across identity, payslip, and bank statement documents: ${details.join("; ")}.`,
      documentIds: entries.map(({ document }) => document.id).filter(Boolean),
    };
  }

  return {
    status: "VERIFIED",
    reason: "Applicant names match across the identity proof, payslips, and bank statements.",
    documentIds: entries.map(({ document }) => document.id).filter(Boolean),
  };
}

function parseDocumentTypeValues(raw) {
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function removeTemporaryUpload(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function findCrossDocumentDifferences(documents, currentValues) {
  const fields = [
    ["gross_income", "gross income"],
    ["net_salary", "net salary"],
    ["employee_name", "employee name"],
    ["account_holder_name", "account holder name"],
  ];
  const differences = [];
  for (const document of documents) {
    const extracted = JSON.parse(document.extractedValues || "{}");
    const previousValues = extracted.valid ? extracted.values : null;
    if (!previousValues) continue;
    for (const [field, label] of fields) {
      const previous = previousValues[field];
      const current = currentValues[field];
      if (previous == null || current == null) continue;
      const matches = typeof previous === "number" && typeof current === "number"
        ? Math.abs(previous - current) < 0.01
        : String(previous).trim().toLowerCase() === String(current).trim().toLowerCase();
      if (!matches) {
        differences.push(`${label} differs between ${document.originalName} (${previous}) and the new document (${current})`);
      }
    }
  }
  return differences;
}

function getExtractedValues(document) {
  const extraction = JSON.parse(document.extractedValues || "{}");
  return extraction.valid ? extraction.values : null;
}

function getIncomeDocumentType(values) {
  // The AI service states the type explicitly; trust it before inferring
  // from fields (a bank statement may legitimately mention income figures).
  if (["salary_slip", "bank_statement"].includes(values?.income_document_type)) {
    return values.income_document_type;
  }
  if (values?.net_salary != null || values?.gross_income != null) return "salary_slip";
  if (values?.last_5_transactions?.length > 0) return "bank_statement";
  return "other";
}

const VERIFIED_INCOME_SOURCE = "Monthly salary (payslip net salary matched to the bank statement salary credit)";

// The Income columns hold the document-verified financial profile (null when
// a figure is not verified). The applicant's stated figures and any
// corrections stay in originalValues/correctedValues and are never mixed in.
async function saveVerifiedFinancialProfile(tx, applicationId, verified) {
  const data = {
    monthlyGross: verified.monthlyGross,
    monthlyNet: verified.monthlyNet,
    monthlyObligations: verified.monthlyObligations,
    incomeSource: verified.monthlyNet != null ? VERIFIED_INCOME_SOURCE : null,
    evidence: JSON.stringify(verified.evidence),
  };
  const existing = await tx.income.findUnique({ where: { applicationId }, select: { id: true } });
  if (existing) {
    await tx.income.update({ where: { applicationId }, data });
    return;
  }
  // A profile is only established once net income is verified (payslip net
  // salary matched to the bank statement salary credit).
  if (data.monthlyNet != null) {
    await tx.income.create({
      data: { applicationId, ...data, originalValues: JSON.stringify({}), correctedValues: JSON.stringify({}) },
    });
  }
}

function salaryCreditTransaction(values) {
  return (values?.last_5_transactions || []).find((transaction) =>
    transaction.type === "CREDIT" && /\b(?:salary|payroll)\b/i.test(transaction.description));
}

function latestIncomeDocument(documents, type) {
  return documents
    .map((document, index) => ({ document, index, type: getIncomeDocumentType(getExtractedValues(document)) }))
    .filter((entry) => entry.type === type)
    .sort((left, right) => {
      const leftDate = left.document.createdAt ? new Date(left.document.createdAt).getTime() : Number.NaN;
      const rightDate = right.document.createdAt ? new Date(right.document.createdAt).getTime() : Number.NaN;
      if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) {
        return rightDate - leftDate || right.index - left.index;
      }
      return right.index - left.index;
    })[0]?.document;
}

function verifyIncomeDocuments(documents) {
  const salarySlip = latestIncomeDocument(documents, "salary_slip");
  const bankStatement = latestIncomeDocument(documents, "bank_statement");
  const verification = {
    status: "NOT_REQUIRED",
    reason: null,
    salarySlipDocumentId: salarySlip?.id || null,
    bankStatementDocumentId: bankStatement?.id || null,
  };
  if (!salarySlip && !bankStatement) return verification;
  const salaryValues = salarySlip ? getExtractedValues(salarySlip) : null;
  const bankValues = bankStatement ? getExtractedValues(bankStatement) : null;
  let salaryNet = null;
  if (salarySlip) {
    salaryNet = salaryValues.net_salary;
    if (!Number.isFinite(salaryNet)) {
      return { ...verification, status: "NEEDS_REVIEW", reason: "Salary slip is missing net salary." };
    }
  }
  const salaryCredit = salaryCreditTransaction(bankValues);
  if (bankStatement && !salaryCredit) {
    return { ...verification, status: "NEEDS_REVIEW", reason: "Bank statement does not contain an identified salary credit in its recent transactions." };
  }
  if (!salarySlip || !bankStatement) {
    const missingLabel = salarySlip ? "bank statement" : "salary slip";
    const missingKind = salarySlip ? "bank-statements" : "payslips";
    const uploadedButUnverified = documents.some((document) =>
      parseDocumentTypeValues(document.extractedValues)?.document_type === missingKind);
    return {
      ...verification,
      status: "PENDING",
      reason: uploadedButUnverified
        ? `The ${missingLabel} could not be verified, so the salary income cannot be matched against it.`
        : `Upload the ${missingLabel} to verify the salary income.`,
    };
  }
  if (Math.round(salaryNet * 100) !== Math.round(salaryCredit.amount * 100)) {
    return { ...verification, status: "NEEDS_REVIEW", reason: "Salary slip net salary does not match the salary credited in the bank statement." };
  }
  return {
    ...verification,
    status: "VERIFIED",
    reason: "Salary slip net salary matches the salary credit shown on the bank statement.",
    salaryNet,
    salaryCredited: salaryCredit.amount,
  };
}

async function processDocumentWorkflow({ user, applicationId, application, rulebook, document, contents }) {
  try {
    const kind = requiredDocumentKind(document);
    const result = await runWorkflow({
      text: contents.toString("base64"),
      filename: document.originalName,
      contentType: document.mimeType,
      expectedDocumentType: kind,
      applicationId,
      documentId: document.id,
      loanAmount: application.loanAmount,
      rulebookVersion: rulebook.version,
      rulebookConfig: rulebook.config,
    });
    const extraction = result.extraction || { valid: false, values: null, errors: ["AI service returned no extraction result"] };
    const values = extraction.values || {};
    const incomeDocumentType = getIncomeDocumentType(values);
    const expectedIncomeDocumentType = kind === "bank-statements"
      ? "bank_statement"
      : kind === "payslips" ? "salary_slip" : null;
    // Only a successful extraction can show that the content is the wrong
    // kind of document; a failed extraction is a review case, not a mismatch.
    const classificationMismatch = Boolean(
      expectedIncomeDocumentType && extraction.valid && extraction.values &&
        incomeDocumentType !== expectedIncomeDocumentType,
    );
    const classificationError = classificationMismatch
      ? `This file does not appear to be ${expectedIncomeDocumentType === "bank_statement" ? "a bank statement" : "a payslip"}. Remove it and upload the correct document.`
      : null;
    let status = classificationMismatch
      ? "NEEDS_REVIEW"
      : result.status === "not_applicable"
      ? "UPLOADED"
      : result.status === "validated" && extraction.valid ? "PROCESSED" : "NEEDS_REVIEW";
    let documentVerification = classificationMismatch
      ? { status: "FAILED", reason: classificationError, field: "income_document_type" }
      : { status: "NOT_REQUIRED", reason: null, field: null };
    const holderFields = {
      aadhaar: ["applicant_name", "Applicant name"],
      payslips: ["employee_name", "Employee name"],
      "bank-statements": ["account_holder_name", "Account holder name"],
    };
    if (holderFields[kind]) {
      const [field, label] = holderFields[kind];
      const extractedName = values[field];
      if (status !== "PROCESSED") {
        documentVerification = classificationMismatch
          ? { status: "FAILED", reason: classificationError, field: "income_document_type" }
          : {
            status: "FAILED",
            reason: result.error || `${label} could not be extracted and verified.`,
            field: null,
          };
      } else if (!extractedName) {
        status = "NEEDS_REVIEW";
        documentVerification = { status: "NEEDS_REVIEW", reason: `${label} could not be extracted.`, field };
      } else if (!matchesApplicantName(extractedName, application.applicant?.fullName)) {
        status = "NEEDS_REVIEW";
        documentVerification = {
          status: "NEEDS_REVIEW",
          reason: `${label} on ${kind === "aadhaar" ? "Aadhaar" : kind === "payslips" ? "payslip" : "bank statement"} does not match the application.`,
          field,
        };
      } else {
        documentVerification = { status: "VERIFIED", reason: `${label} matches the application applicant.`, field };
      }
    }
    let crossDocumentDifferences = [];
    const isIdentityDocument = kind === "aadhaar";
    const previousDocuments = await prisma.document.findMany({
      where: { applicationId, status: { in: ["PROCESSED", "NEEDS_REVIEW"] }, id: { not: document.id } },
      select: { id: true, status: true, originalName: true, extractedValues: true, extractionError: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const documentRecords = [...previousDocuments, {
      id: document.id,
      originalName: document.originalName,
      extractedValues: JSON.stringify({
        ...extraction,
        ...(kind ? { document_type: kind } : {}),
        document_verification: documentVerification,
      }),
      createdAt: document.createdAt,
    }];
    const identityVerification = compareDocumentNames(documentRecords);
    if (identityVerification.status === "MISMATCH") status = "NEEDS_REVIEW";
    const incomeVerification = extraction.valid && extraction.values &&
      ["salary_slip", "bank_statement"].includes(incomeDocumentType)
      ? verifyIncomeDocuments(documentRecords)
      : { status: "NOT_REQUIRED", reason: null, salarySlipDocumentId: null, bankStatementDocumentId: null };
    if (holderFields[kind] && documentVerification.status !== "VERIFIED") status = "NEEDS_REVIEW";
    if (status === "PROCESSED" && extraction.values && !isIdentityDocument) {
      crossDocumentDifferences = findCrossDocumentDifferences(
        previousDocuments.filter((item) => item.status === "PROCESSED"),
        extraction.values,
      );
      if (crossDocumentDifferences.length) status = "NEEDS_REVIEW";
    }
    const documentIsUploadOnly = status === "UPLOADED";
    if (!documentIsUploadOnly && (incomeVerification.status === "PENDING" || incomeVerification.status === "NEEDS_REVIEW")) {
      status = "NEEDS_REVIEW";
    }
    const workflow = identityVerification.status === "MISMATCH" ? {
      ...result,
      status: "needs_review",
      error: identityVerification.reason,
      decision: {
        outcome: "REFER",
        dti_percent: null,
        rules_triggered: ["CROSS_DOCUMENT_IDENTITY_MISMATCH", "MANUAL_REVIEW_REQUIRED"],
        rulebook_version: rulebook.version,
        reason: identityVerification.reason,
      },
      explanation: `Outcome: REFER. ${identityVerification.reason} No automated eligibility decision was made.`,
      referral: { required: true, reason: identityVerification.reason },
      identity_verification: identityVerification,
      income_verification: incomeVerification,
    } : classificationMismatch ? {
      ...result,
      status: "needs_review",
      error: classificationError,
      decision: {
        outcome: "REFER",
        dti_percent: null,
        rules_triggered: ["DOCUMENT_TYPE_MISMATCH", "MANUAL_REVIEW_REQUIRED"],
        rulebook_version: rulebook.version,
        reason: classificationError,
      },
      explanation: `Outcome: REFER. ${classificationError} No financial values from this document were applied.`,
      referral: { required: true, reason: classificationError },
      income_verification: incomeVerification,
    } : crossDocumentDifferences.length ? {
      ...result,
      status: "needs_review",
      error: `${crossDocumentDifferences.join(". ")}. Manual review is required.`,
      decision: {
        outcome: "REFER",
        dti_percent: null,
        rules_triggered: ["CROSS_DOCUMENT_VALUES_DIFFER", "MANUAL_REVIEW_REQUIRED"],
        rulebook_version: rulebook.version,
        reason: "Financial values differ across submitted documents; verify the source documents before calculating eligibility.",
      },
      explanation: (
        `Outcome: REFER. ${crossDocumentDifferences.join(". ")}. ` +
        "No values from the new document were applied to the financial profile. Manual review is required. " +
        `Rulebook: ${rulebook.version}.`
      ),
      referral: { required: true, reason: "Financial values differ across submitted documents." },
      income_verification: incomeVerification,
    } : !documentIsUploadOnly && (incomeVerification.status === "PENDING" || incomeVerification.status === "NEEDS_REVIEW") ? {
      ...result,
      status: "needs_review",
      error: incomeVerification.reason,
      decision: {
        outcome: "REFER",
        dti_percent: null,
        rules_triggered: [incomeVerification.status === "PENDING" ? "INCOME_VERIFICATION_PENDING" : "INCOME_VERIFICATION_FAILED", "MANUAL_REVIEW_REQUIRED"],
        rulebook_version: rulebook.version,
        reason: incomeVerification.reason,
      },
      explanation: `Outcome: REFER. ${incomeVerification.reason} Financial figures are not used until income verification is complete. Rulebook: ${rulebook.version}.`,
      referral: { required: true, reason: incomeVerification.reason },
      income_verification: incomeVerification,
    } : result;
    workflow.income_verification = incomeVerification;
    workflow.document_verification = documentVerification;
    workflow.identity_verification = identityVerification;
    const updated = await prisma.$transaction(async (tx) => {
      const updatedDocument = await tx.document.update({
        where: { id: document.id },
        data: {
          status,
          extractedText: result.extracted_text || null,
          extractedValues: JSON.stringify({
            ...extraction,
            ...(kind ? { document_type: kind } : {}),
            upload_validation: parseDocumentTypeValues(document.extractedValues)?.upload_validation || null,
            income_verification: incomeVerification,
            document_verification: documentVerification,
            identity_verification: identityVerification,
          }),
          extractionError: classificationError || (identityVerification.status === "MISMATCH" ? identityVerification.reason : crossDocumentDifferences.length ? workflow.error : result.error || null),
        },
      });
      if (identityVerification.documentIds.length) {
        for (const identityDocumentId of identityVerification.documentIds) {
          if (identityDocumentId === document.id) continue;
          const identityDocument = documentRecords.find((item) => item.id === identityDocumentId);
          if (!identityDocument) continue;
          const savedExtraction = JSON.parse(identityDocument.extractedValues || "{}");
          const previousIdentityMismatch = savedExtraction.identity_verification?.status === "MISMATCH";
          await tx.document.update({
            where: { id: identityDocumentId },
            data: {
              ...(identityVerification.status === "MISMATCH"
                ? { status: "NEEDS_REVIEW", extractionError: identityVerification.reason }
                : previousIdentityMismatch
                  ? { status: "PROCESSED", extractionError: null }
                  : {}),
              extractedValues: JSON.stringify({
                ...savedExtraction,
                identity_verification: identityVerification,
              }),
            },
          });
        }
      }
      if (incomeVerification.status === "VERIFIED") {
        const verifiedDocumentIds = [incomeVerification.salarySlipDocumentId, incomeVerification.bankStatementDocumentId]
          .filter((id) => id && id !== document.id);
        for (const verifiedDocumentId of verifiedDocumentIds) {
          const verifiedDocument = documentRecords.find((item) => item.id === verifiedDocumentId);
          const savedExtraction = JSON.parse(verifiedDocument.extractedValues || "{}");
          const incomeReviewCleared = ["PENDING", "NEEDS_REVIEW"].includes(savedExtraction.income_verification?.status) &&
            !verifiedDocument.extractionError;
          await tx.document.update({
            where: { id: verifiedDocument.id },
            data: {
              ...(incomeReviewCleared ? { status: "PROCESSED", extractionError: null } : {}),
              extractedValues: JSON.stringify({ ...savedExtraction, income_verification: incomeVerification }),
            },
          });
        }
      }
      const applicationDocuments = await tx.document.findMany({
        where: { applicationId },
        select: { id: true, originalName: true, status: true, extractedValues: true, extractionError: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const incomeProfile = await tx.income.findUnique({ where: { applicationId } });
      const readiness = assessDocumentReadiness(applicationDocuments, incomeProfile);
      await saveVerifiedFinancialProfile(tx, applicationId, readiness.verifiedFinancials);
      workflow.document_readiness = readiness;
      workflow.decision = null;
      workflow.explanation = null;
      workflow.referral = { required: !readiness.ready, reason: readiness.reason };
      await tx.auditLog.create({
        data: {
      applicationId,
      actorId: user.sub,
      action: crossDocumentDifferences.length ? "CROSS_DOCUMENT_VALUES_DIFFER" : status === "UPLOADED" ? "DOCUMENT_RECEIVED" : "AI_WORKFLOW_COMPLETED",
      details: JSON.stringify({
        documentId: document.id, status,
        differences: crossDocumentDifferences,
        incomeVerification,
        documentVerification,
      }),
        },
      });
      return { updatedDocument };
    });
    return { document: updated.updatedDocument, workflow };
  } catch (error) {
    const failedDocument = await prisma.$transaction(async (tx) => {
      const failed = await tx.document.update({
        where: { id: document.id },
        data: { status: "NEEDS_REVIEW", extractionError: error.message },
      });
      await tx.auditLog.create({
        data: { applicationId, actorId: user.sub, action: "DOCUMENT_PROCESSING_FAILED", details: JSON.stringify({ documentId: document.id, code: error.code || "PROCESSING_ERROR" }) },
      });
      return failed;
    });
    if (error instanceof AppError) return { document: failedDocument, error: { code: error.code, message: error.message } };
    throw error;
  }
}

export async function uploadDocument(user, applicationId, file, idempotencyKey, requestedKind) {
  if (!file) throw new AppError(400, "FILE_REQUIRED", "Upload a PDF document");
  if (file.mimetype !== "application/pdf" || path.extname(file.originalname).toLowerCase() !== ".pdf") {
    await removeTemporaryUpload(file.path);
    throw new AppError(400, "UNSUPPORTED_FILE", "Only PDF documents are supported");
  }
  if (requestedKind && !["aadhaar", "payslips", "bank-statements"].includes(requestedKind)) {
    await removeTemporaryUpload(file.path);
    throw new AppError(400, "INVALID_DOCUMENT_TYPE", "Select Aadhaar, payslip, or bank statement for this upload");
  }
  let documentType = requestedKind || null;
  let application;
  try {
    application = await getApplication(user, applicationId);
  } catch (error) {
    await removeTemporaryUpload(file.path);
    throw error;
  }
  let operation;
  try {
    operation = await beginOperation(
      user.sub,
      idempotencyKey,
      `DOCUMENT:${applicationId}`,
      createHash("sha256").update(JSON.stringify({
        content: createHash("sha256").update(await readFile(file.path)).digest("hex"),
        documentType,
      })).digest("hex"),
      true,
    );
  } catch (error) {
    await removeTemporaryUpload(file.path);
    throw error;
  }
  if (operation.replayId) {
    await removeTemporaryUpload(file.path);
    const previous = await prisma.document.findUnique({ where: { id: operation.replayId } });
    if (!previous) throw new AppError(404, "DOCUMENT_NOT_FOUND", "The previously uploaded document is unavailable");
    const savedValues = parseDocumentTypeValues(previous.extractedValues);
    return {
      document: previous,
      documentValidation: savedValues?.upload_validation || null,
      replayed: true,
    };
  }

  if (operation.resumeId) {
    await removeTemporaryUpload(file.path);
    const document = await prisma.document.findFirst({ where: { id: operation.resumeId, applicationId } });
    if (!document) throw new AppError(404, "DOCUMENT_NOT_FOUND", "The interrupted document is unavailable");
    await completeOperation(operation.recordId, document.id);
    return { document, replayed: true };
  }

  let documentValidation;
  try {
    const contents = await readFile(file.path);
    if (contents.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new AppError(400, "INVALID_FILE_SIGNATURE", "The uploaded file is not a valid PDF");
    }

    // Only ID proofs, payslips and bank statements are saved, and the content
    // must match the slot it was uploaded to. Anything else is rejected here,
    // before a document record or file is kept.
    const validation = await validateDocument({
      content: contents,
      filename: file.originalname,
      contentType: file.mimetype,
      expectedDocumentType: documentType,
    });
    const accepted = validation.valid === true &&
      REQUIRED_DOCUMENT_TYPES.includes(validation.document_type) &&
      (!documentType || validation.document_type === documentType);
    if (!accepted) {
      throw new AppError(
        422,
        "DOCUMENT_VALIDATION_REJECTED",
        validation.message || DOCUMENT_REJECTED_MESSAGE,
        {
          detectedDocumentType: validation.document_type ?? null,
          expectedDocumentType: documentType,
          reasons: Array.isArray(validation.reasons) ? validation.reasons : [],
        },
      );
    }
    documentValidation = {
      valid: true,
      document_type: validation.document_type,
      message: validation.message,
      matched_indicators: Array.isArray(validation.matched_indicators) ? validation.matched_indicators : [],
    };
    documentType ||= validation.document_type;
  } catch (error) {
    await cancelOperation(operation.recordId);
    await removeTemporaryUpload(file.path);
    throw error;
  }

  let document;
  try {
    document = await prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          applicationId, originalName: file.originalname, storedName: file.filename,
          mimeType: file.mimetype, sizeBytes: file.size, status: "UPLOADED",
          extractedValues: documentType ? JSON.stringify({
            document_type: documentType,
            upload_validation: documentValidation,
          }) : null,
        },
      });
      await tx.idempotencyRecord.update({ where: { id: operation.recordId }, data: { resultId: created.id } });
      await tx.auditLog.create({
        data: { applicationId, actorId: user.sub, action: "DOCUMENT_UPLOADED", details: JSON.stringify({ documentId: created.id, sizeBytes: file.size }) },
      });
      await completeOperation(operation.recordId, created.id, tx);
      return created;
    });
  } catch (error) {
    await cancelOperation(operation.recordId);
    await removeTemporaryUpload(file.path);
    throw error;
  }
  return { document, documentValidation };
}

function latestRequiredDocuments(documents = []) {
  const latest = new Map();
  for (const document of documents) {
    const kind = requiredDocumentKind(document);
    if (!kind) continue;
    const previous = latest.get(kind);
    const previousTime = previous?.createdAt ? new Date(previous.createdAt).getTime() : Number.NaN;
    const currentTime = document.createdAt ? new Date(document.createdAt).getTime() : Number.NaN;
    if (!previous || !Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime >= previousTime) {
      latest.set(kind, document);
    }
  }
  return latest;
}

export async function extractApplicationDocuments(user, applicationId, idempotencyKey) {
  const application = await getApplication(user, applicationId);
  const latest = latestRequiredDocuments(application.documents);
  const requiredKinds = ["aadhaar", "payslips", "bank-statements"];
  const latestDocuments = requiredKinds.map((kind) => latest.get(kind)).filter(Boolean);
  // Extract only documents not yet extracted (for example a replaced payslip);
  // the cross-document checks are recomputed against the stored results of
  // the others. Everything is re-run only when nothing new is waiting.
  const waiting = latestDocuments.filter((document) => document.status === "UPLOADED");
  const documents = waiting.length ? waiting : latestDocuments;
  if (!documents.length) {
    throw new AppError(409, "REQUIRED_DOCUMENTS_MISSING", "Upload at least one required document before starting extraction");
  }
  const operation = await beginOperation(
    user.sub,
    idempotencyKey,
    `EXTRACT:${applicationId}`,
    documents.map(({ id }) => id),
    true,
  );
  if (operation.replayId) {
    return { applicationId, documentIds: documents.map(({ id }) => id), processing: false, replayed: true };
  }
  if (application.workflow?.ready) {
    if (operation.resumeId) {
      await completeOperation(operation.recordId, applicationId);
      return { applicationId, documentIds: documents.map(({ id }) => id), processing: false, replayed: true };
    }
    await cancelOperation(operation.recordId);
    throw new AppError(409, "EXTRACTION_ALREADY_COMPLETED", "All required documents have already passed verification");
  }
  if (documents.some((document) => document.status === "PROCESSING") && !operation.resumeId) {
    await cancelOperation(operation.recordId);
    throw new AppError(409, "DOCUMENT_PROCESSING", "Wait for the current document extraction to finish");
  }

  let contents;
  const directory = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  try {
    contents = await Promise.all(documents.map((document) =>
      readFile(path.join(directory, path.basename(document.storedName)))));
  } catch (error) {
    await cancelOperation(operation.recordId);
    if (error.code === "ENOENT") {
      throw new AppError(404, "DOCUMENT_FILE_NOT_FOUND", "A stored source document is unavailable");
    }
    throw error;
  }
  let rulebook;
  try {
    rulebook = await activeRulebook();
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const document of documents) {
        await tx.document.update({ where: { id: document.id }, data: { status: "PROCESSING" } });
      }
      await tx.idempotencyRecord.update({
        where: { id: operation.recordId },
        data: { resultId: applicationId },
      });
      await tx.auditLog.create({
        data: {
          applicationId,
          actorId: user.sub,
          action: "DOCUMENT_EXTRACTION_STARTED",
          details: JSON.stringify({ documentIds: documents.map(({ id }) => id) }),
        },
      });
    });
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }

  scheduleDocumentWorkflows({
    user,
    applicationId,
    application,
    rulebook,
    documents,
    contentsById: new Map(documents.map((document, index) => [document.id, contents[index]])),
    operationId: operation.recordId,
  });
  return { applicationId, documentIds: documents.map(({ id }) => id), processing: true };
}

export async function listDocuments(user, { page, limit, status }) {
  const where = {
    ...(["OFFICER", "AUDITOR"].includes(user.role) ? {} : { application: { userId: user.sub } }),
    ...(status ? { status } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.document.findMany({
      where,
      include: { application: { select: { id: true, applicationNo: true, status: true, userId: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.document.count({ where }),
  ]);
  return { items, page, limit, total };
}

export async function getDocument(user, id) {
  const item = await prisma.document.findFirst({
    where: { id },
    include: { application: { select: { id: true, applicationNo: true, status: true, userId: true } } },
  });
  if (!item) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  if (!["OFFICER", "AUDITOR"].includes(user.role) && item.application.userId !== user.sub) {
    throw new AppError(403, "FORBIDDEN", "Document does not belong to the caller");
  }
  return item;
}

export async function getDocumentFile(user, id) {
  const document = await getDocument(user, id);
  const directory = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  const filePath = path.join(directory, path.basename(document.storedName));
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new AppError(404, "DOCUMENT_FILE_NOT_FOUND", "Stored source document is unavailable");
    throw error;
  }
  return { path: filePath, filename: document.originalName, mimeType: document.mimeType };
}

export async function deleteDocument(user, id) {
  const document = await getDocument(user, id);
  if (document.status === "PROCESSING") {
    throw new AppError(409, "DOCUMENT_PROCESSING", "Wait for document processing to finish before removing it");
  }
  const directory = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  const filePath = path.join(directory, path.basename(document.storedName));
  const rulebook = await activeRulebook();

  await prisma.$transaction(async (tx) => {
    const current = await tx.document.findUnique({ where: { id } });
    if (!current) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    if (current.status === "PROCESSING") {
      throw new AppError(409, "DOCUMENT_PROCESSING", "Wait for document processing to finish before removing it");
    }
    const existingReview = await tx.review.findFirst({ where: { applicationId: current.applicationId } });
    if (existingReview) {
      throw new AppError(409, "APPLICATION_ALREADY_REVIEWED", "Documents cannot be removed after an officer review");
    }
    await tx.document.delete({ where: { id } });
    await tx.idempotencyRecord.deleteMany({
      where: { userId: user.sub, operation: `DOCUMENT:${current.applicationId}`, resultId: current.id },
    });
    await tx.decision.create({
      data: {
        applicationId: current.applicationId,
        outcome: "REFER",
        dtiPercent: null,
        rulesTriggered: JSON.stringify(["DOCUMENT_REMOVED", "MANUAL_REVIEW_REQUIRED"]),
        rulebookVersion: rulebook.version,
        explanation: "A supporting document was removed. Eligibility must be recalculated after the required documents are uploaded again.",
      },
    });
    await tx.application.update({ where: { id: current.applicationId }, data: { status: "REFER" } });
    await tx.auditLog.create({
      data: {
        applicationId: current.applicationId,
        actorId: user.sub,
        action: "DOCUMENT_REMOVED",
        details: JSON.stringify({ documentId: current.id, originalName: current.originalName }),
      },
    });
  });

  await removeTemporaryUpload(filePath);
  return { id, deleted: true };
}
