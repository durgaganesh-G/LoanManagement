import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";
import { beginOperation, cancelOperation, completeOperation } from "./idempotencyService.js";
import { logger } from "../utils/logger.js";
import { assessDocumentReadiness } from "./documentReadiness.js";

function scope(user) {
  return ["OFFICER", "AUDITOR"].includes(user.role) ? {} : { userId: user.sub };
}

function withReviewOutcome(application) {
  const latestReview = application.reviews?.[0];
  return latestReview ? { ...application, status: latestReview.outcome } : application;
}

export async function createApplication(user, data, idempotencyKey) {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid Idempotency-Key header");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const existing = await prisma.application.findFirst({
    where: { userId: user.sub, idempotencyKey },
    include: { applicant: true, income: true },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
    return { application: existing, replayed: true };
  }
  try {
    const application = await prisma.application.create({
      data: {
        applicationNo: `BNK-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        loanAmount: data.loanAmount,
        loanTermMonths: data.loanTermMonths,
        idempotencyKey,
        requestHash,
        userId: user.sub,
        applicant: { create: data.applicant },
        // Figures typed on the form are the applicant's statement, kept in
        // originalValues. The monthly* columns are filled only with figures
        // verified from the uploaded documents.
        ...(data.financial ? {
          income: { create: {
            originalValues: JSON.stringify(data.financial),
            correctedValues: JSON.stringify({}),
          } },
        } : {}),
        audits: { create: { actorId: user.sub, action: "APPLICATION_CREATED", details: "{}" } },
      },
      include: { applicant: true, income: true },
    });
    return { application, replayed: false };
  } catch (error) {
    if (error.code !== "P2002") throw error;
    const replay = await prisma.application.findFirst({ where: { userId: user.sub, idempotencyKey }, include: { applicant: true, income: true } });
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
      }
      return { application: replay, replayed: true };
    }
    throw error;
  }
}

export async function listApplications(user, { page, limit, status }) {
  const where = {
    ...scope(user),
    ...(status ? {
      OR: [
        { status, reviews: { none: {} } },
        { reviews: { some: { outcome: status } } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where, include: { applicant: true, reviews: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit, take: limit,
    }),
    prisma.application.count({ where }),
  ]);
  return { items: items.map(withReviewOutcome), page, limit, total };
}

export async function getApplication(user, id) {
  const application = await prisma.application.findFirst({
    where: { id },
    include: {
      applicant: true,
      documents: true,
      income: true,
      decisions: { orderBy: { createdAt: "desc" }, take: 1 },
      reviews: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!application) throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
  if (!["OFFICER", "AUDITOR"].includes(user.role) && application.userId !== user.sub) {
    throw new AppError(403, "FORBIDDEN", "Application does not belong to the caller");
  }
  const documentReadiness = assessDocumentReadiness(application.documents, application.income);
  const originalFinancials = application.income?.originalValues
    ? JSON.parse(application.income.originalValues)
    : {};
  const correctedFinancials = application.income?.correctedValues
    ? JSON.parse(application.income.correctedValues)
    : {};
  const applicantProvidedFinancials = Object.fromEntries(
    ["monthlyGross", "monthlyNet", "monthlyObligations"].map((key) => [
      key,
      Object.hasOwn(correctedFinancials, key) ? correctedFinancials[key] : originalFinancials[key] ?? null,
    ]),
  );
  const latestDecision = application.decisions[0];
  const decisionRules = latestDecision ? JSON.parse(latestDecision.rulesTriggered) : [];
  const manualDecision = latestDecision?.outcome === "REFER" && decisionRules.includes("MANUAL_REVIEW_REQUIRED");
  const workflowStatus = manualDecision
    ? "MANUAL_REVIEW_REQUIRED"
    : latestDecision
      ? "ELIGIBILITY_COMPLETED"
      : documentReadiness.processing
        ? "EXTRACTING"
        : !application.documents.length
          ? "DRAFT"
          : documentReadiness.complete
            ? documentReadiness.ready ? "READY_FOR_ELIGIBILITY" : "VERIFICATION_FAILED"
            : application.documents.some((document) => document.status !== "UPLOADED")
              ? "EXTRACTION_COMPLETED"
              : "DOCUMENTS_UPLOADED";
  return {
    ...withReviewOutcome(application),
    applicantProvidedFinancials,
    workflow: { status: workflowStatus, ...documentReadiness },
  };
}

export async function deleteApplication(user, id) {
  const application = await getApplication(user, id);
  if (application.documents.some((document) => document.status === "PROCESSING")) {
    throw new AppError(409, "APPLICATION_PROCESSING", "Wait for document processing to finish before removing this application");
  }
  const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  const filePaths = application.documents.map((document) =>
    path.join(uploadDirectory, path.basename(document.storedName)));

  await prisma.$transaction(async (tx) => {
    const current = await tx.application.findUnique({
      where: { id },
      include: { documents: { select: { status: true } } },
    });
    if (!current) throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
    if (current.documents.some((document) => document.status === "PROCESSING")) {
      throw new AppError(409, "APPLICATION_PROCESSING", "Wait for document processing to finish before removing this application");
    }
    await tx.idempotencyRecord.deleteMany({
      where: {
        userId: current.userId,
        operation: { in: [`DOCUMENT:${id}`, `PROFILE:${id}`, `DECISION:${id}`, `EXTRACT:${id}`, `MANUAL_REVIEW:${id}`, `REVIEW:${id}`] },
      },
    });
    await tx.application.delete({ where: { id } });
  });

  const cleanupResults = await Promise.allSettled(filePaths.map((filePath) => unlink(filePath)));
  const cleanupErrors = cleanupResults.filter((result) => result.status === "rejected" && result.reason.code !== "ENOENT");
  if (cleanupErrors.length) {
    logger.error({ applicationId: id, errorCount: cleanupErrors.length }, "Unable to remove all uploaded files for deleted application");
    throw new AppError(500, "APPLICATION_FILE_CLEANUP_FAILED", "Application was removed, but some stored document files could not be deleted");
  }
  return { id, deleted: true };
}

export async function updateProfile(user, applicationId, values, idempotencyKey) {
  const app = await getApplication(user, applicationId);
  const operation = await beginOperation(user.sub, idempotencyKey, `PROFILE:${applicationId}`, values);
  if (operation.replayId) {
    const income = await prisma.income.findUnique({ where: { id: operation.replayId } });
    if (!income) throw new AppError(404, "PROFILE_NOT_FOUND", "The previously updated financial profile is unavailable");
    return { ...app, income };
  }
  // Corrections change what the applicant states, never the figures verified
  // from documents. If a corrected net income no longer matches the verified
  // income, the eligibility engine refers the application to a loan officer.
  const previous = await prisma.income.findUnique({ where: { applicationId } });
  const before = app.applicantProvidedFinancials || {};
  const employment = Object.hasOwn(values, "employment") ? { employment: values.employment } : {};
  try {
    const profile = await prisma.income.upsert({
      where: { applicationId },
      create: { applicationId, ...employment, originalValues: JSON.stringify({}), correctedValues: JSON.stringify(values) },
      update: { ...employment, originalValues: previous?.originalValues ?? JSON.stringify({}), correctedValues: JSON.stringify(values) },
    });
    await prisma.auditLog.create({
      data: { applicationId, actorId: user.sub, action: "PROFILE_CORRECTED", details: JSON.stringify({ before, after: values }) },
    });
    await completeOperation(operation.recordId, profile.id);
    return { ...app, income: profile };
  } catch (error) {
    await cancelOperation(operation.recordId);
    throw error;
  }
}
