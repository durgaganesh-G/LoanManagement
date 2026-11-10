import { prisma } from "../data-access/prisma.js";
import { assessDocumentReadiness } from "./documentReadiness.js";

// Notifications are derived from the audit history, so every notification
// points to something that really happened and no extra table is needed.
// Read state is kept by the client (per user, per browser).

const DOCUMENT_LABELS = { aadhaar: "ID proof", payslips: "Payslip", "bank-statements": "Bank statement" };
const COMPLETION_ACTIONS = ["AI_WORKFLOW_COMPLETED", "CROSS_DOCUMENT_VALUES_DIFFER", "DOCUMENT_RECEIVED", "DOCUMENT_PROCESSING_FAILED"];
const DECISION_ACTIONS = ["ELIGIBILITY_CALCULATED", "MANUAL_REVIEW_REFER_RECORDED"];
const ROLE_ACTIONS = {
  APPLICANT: ["DOCUMENT_EXTRACTION_STARTED", ...COMPLETION_ACTIONS, ...DECISION_ACTIONS, "OFFICER_REVIEW_RECORDED"],
  OFFICER: DECISION_ACTIONS,
  AUDITOR: [...DECISION_ACTIONS, "OFFICER_REVIEW_RECORDED"],
};
const REVIEW_LABELS = { APPROVED: "Approved", DECLINED: "Declined", MORE_INFORMATION: "More information requested" };

function parse(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function shorten(text, length = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function decisionLink(user, applicationId) {
  return user.role === "AUDITOR" ? `/applications/${applicationId}/audit` : `/applications/${applicationId}/decision`;
}

function decisionNotification(user, base, event, details, decision) {
  const application = event.application;
  const referred = event.action === "MANUAL_REVIEW_REFER_RECORDED" || (decision?.outcome ?? details.outcome) === "REFER";
  if (user.role === "OFFICER") {
    if (!referred) return null;
    return {
      ...base,
      type: "REFERRAL",
      tone: "warning",
      title: `New referral: ${application.applicationNo}`,
      message: `${application.applicant?.fullName || "An applicant"} is waiting for a loan officer review.`,
      link: "/referrals",
    };
  }
  if (event.action === "MANUAL_REVIEW_REFER_RECORDED") {
    const firstFailure = Array.isArray(details.failures) ? details.failures[0]?.reason : null;
    return {
      ...base,
      type: "MANUAL_REVIEW",
      tone: "warning",
      title: `Referred for manual review: ${application.applicationNo}`,
      message: shorten(firstFailure || details.reason || "The documents could not be fully verified."),
      link: decisionLink(user, application.id),
    };
  }
  const outcome = decision?.outcome ?? details.outcome;
  const dti = decision?.dtiPercent != null ? ` (DTI ${decision.dtiPercent}%)` : "";
  const version = details.rulebookVersion ? ` under rulebook ${details.rulebookVersion}` : "";
  const text = {
    ELIGIBLE: { tone: "success", message: `Eligible${version}${dti}.` },
    NOT_ELIGIBLE: { tone: "danger", message: `Not eligible${version}${dti}.` },
    REFER: { tone: "warning", message: `Referred to a loan officer for review${dti}.` },
  }[outcome] || { tone: "info", message: "A new eligibility result is available." };
  return {
    ...base,
    type: "ELIGIBILITY_RESULT",
    tone: text.tone,
    title: `Eligibility result: ${application.applicationNo}`,
    message: text.message,
    link: decisionLink(user, application.id),
  };
}

function reviewNotification(user, base, event, details) {
  const outcome = details.outcome;
  return {
    ...base,
    type: "OFFICER_REVIEW",
    tone: outcome === "APPROVED" ? "success" : outcome === "DECLINED" ? "danger" : "info",
    title: `Loan officer decision: ${REVIEW_LABELS[outcome] || outcome || "Recorded"}`,
    message: shorten(details.remarks || `Application ${event.application.applicationNo} was reviewed.`),
    link: decisionLink(user, event.application.id),
  };
}

// One notification per application for its latest document check, once every
// document in that check has finished. The summary reflects the current
// verification state, so it matches what the documents page shows.
async function documentCheckNotifications(events) {
  const latestRunByApplication = new Map();
  for (const event of events) {
    if (event.action === "DOCUMENT_EXTRACTION_STARTED" && !latestRunByApplication.has(event.applicationId)) {
      latestRunByApplication.set(event.applicationId, event);
    }
  }
  if (!latestRunByApplication.size) return [];

  const documents = await prisma.document.findMany({
    where: { applicationId: { in: [...latestRunByApplication.keys()] } },
    select: { id: true, applicationId: true, originalName: true, status: true, extractedValues: true, extractionError: true, createdAt: true },
  });

  const notifications = [];
  for (const [applicationId, run] of latestRunByApplication) {
    const documentIds = parse(run.details).documentIds || [];
    const finishedAt = documentIds.map((documentId) => events
      .filter((event) => COMPLETION_ACTIONS.includes(event.action) && event.applicationId === applicationId &&
        event.createdAt >= run.createdAt && parse(event.details).documentId === documentId)
      .map((event) => event.createdAt.getTime())
      .sort((left, right) => left - right)[0]);
    if (!documentIds.length || finishedAt.some((time) => time === undefined)) continue;

    const applicationDocuments = documents.filter((document) => document.applicationId === applicationId);
    if (applicationDocuments.some((document) => document.status === "PROCESSING")) continue;
    const readiness = assessDocumentReadiness(applicationDocuments);
    const base = {
      id: `document-check-${run.id}`,
      applicationId,
      applicationNo: run.application.applicationNo,
      createdAt: new Date(Math.max(...finishedAt)),
    };
    if (readiness.ready) {
      notifications.push({
        ...base,
        type: "DOCUMENT_CHECK",
        tone: "success",
        title: `Documents verified: ${base.applicationNo}`,
        message: "Your ID proof, payslip and bank statement passed every check. You can run eligibility now.",
        link: `/applications/${applicationId}/profile`,
      });
      continue;
    }
    const first = readiness.failures[0];
    const others = new Set(readiness.failures.map((failure) => failure.documentType)).size - 1;
    notifications.push({
      ...base,
      type: "DOCUMENT_CHECK",
      tone: "warning",
      title: `Documents need attention: ${base.applicationNo}`,
      message: shorten(first
        ? `${DOCUMENT_LABELS[first.documentType] || "Document"}: ${first.reason}${others > 0 ? ` (and ${others} more)` : ""}`
        : "Some document checks did not pass."),
      link: `/applications/${applicationId}/documents`,
    });
  }
  return notifications;
}

export async function listNotifications(user, { limit = 20 } = {}) {
  const actions = ROLE_ACTIONS[user.role] || ROLE_ACTIONS.APPLICANT;
  const events = await prisma.auditLog.findMany({
    where: {
      action: { in: actions },
      ...(user.role === "APPLICANT" ? { application: { userId: user.sub } } : {}),
    },
    include: { application: { select: { id: true, applicationNo: true, status: true, applicant: { select: { fullName: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const decisionIds = events
    .filter((event) => DECISION_ACTIONS.includes(event.action))
    .map((event) => parse(event.details).decisionId)
    .filter(Boolean);
  const decisions = new Map((await prisma.decision.findMany({
    where: { id: { in: decisionIds } },
    select: { id: true, outcome: true, dtiPercent: true },
  })).map((decision) => [decision.id, decision]));

  // Officers only see referrals that are still in the referral queue: the
  // application's current status is REFER, it has no review after the
  // referral, and only its latest referral is shown.
  const referralShown = new Set();
  const reviewedAt = new Map();
  if (user.role === "OFFICER") {
    const reviews = await prisma.review.findMany({
      where: { applicationId: { in: [...new Set(events.map((event) => event.applicationId))] } },
      select: { applicationId: true, createdAt: true },
    });
    for (const review of reviews) {
      const latest = reviewedAt.get(review.applicationId);
      if (!latest || review.createdAt > latest) reviewedAt.set(review.applicationId, review.createdAt);
    }
  }

  const notifications = [];
  for (const event of events) {
    const details = parse(event.details);
    const base = { id: event.id, applicationId: event.application.id, applicationNo: event.application.applicationNo, createdAt: event.createdAt };
    if (user.role === "OFFICER") {
      if (event.application.status !== "REFER" || referralShown.has(event.applicationId)) continue;
      if (reviewedAt.get(event.applicationId) >= event.createdAt) continue;
    }
    if (DECISION_ACTIONS.includes(event.action)) {
      const notification = decisionNotification(user, base, event, details, decisions.get(details.decisionId));
      if (notification) {
        notifications.push(notification);
        if (user.role === "OFFICER") referralShown.add(event.applicationId);
      }
    } else if (event.action === "OFFICER_REVIEW_RECORDED") {
      notifications.push(reviewNotification(user, base, event, details));
    }
  }
  if (user.role === "APPLICANT") notifications.push(...await documentCheckNotifications(events));

  const items = notifications
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, limit)
    .map((notification) => ({ ...notification, createdAt: new Date(notification.createdAt).toISOString() }));
  return { items };
}
