import { createApplication, deleteApplication, getApplication, listApplications, updateProfile } from "../services/applicationService.js";
import { getApplicant, listApplicants } from "../services/applicantService.js";
import { uploadDocument, extractApplicationDocuments, deleteDocument, getDocumentFile, getDocument, listDocuments } from "../services/documentService.js";
import { getAudit, getDecision, listReferrals, recordManualReview, rerunEligibility, reviewReferral } from "../services/decisionService.js";
import { listRulebooks } from "../services/rulebookService.js";
import { listNotifications } from "../services/notificationService.js";
import { asyncRoute, parseOrThrow } from "../utils/errors.js";
import { applicantParamsSchema, applicationSchema, aiRunSchema, applicationParamsSchema, documentParamsSchema, listQuerySchema, profileSchema, reviewSchema } from "../validators/schemas.js";

const query = (req) => parseOrThrow(listQuerySchema, req.query);
const applicationId = (req) => parseOrThrow(applicationParamsSchema, req.params).applicationId;

export const create = asyncRoute(async (req, res) => {
  const result = await createApplication(req.user, parseOrThrow(applicationSchema, req.body), req.get("Idempotency-Key"));
  res.status(result.replayed ? 200 : 201).json(result.application);
});
export const list = asyncRoute(async (req, res) => res.json(await listApplications(req.user, query(req))));
export const details = asyncRoute(async (req, res) => res.json(await getApplication(req.user, applicationId(req))));
export const removeApplication = asyncRoute(async (req, res) => {
  const result = await deleteApplication(req.user, applicationId(req));
  res.json(result);
});
export const profileUpdate = asyncRoute(async (req, res) => res.json(await updateProfile(req.user, applicationId(req), parseOrThrow(profileSchema, req.body), req.get("Idempotency-Key"))));
export const upload = asyncRoute(async (req, res) => {
  const result = await uploadDocument(req.user, applicationId(req), req.file, req.get("Idempotency-Key"), req.body.documentType);
  res.status(result.replayed ? 200 : 201).json(result);
});
export const extract = asyncRoute(async (req, res) => {
  const result = await extractApplicationDocuments(req.user, applicationId(req), req.get("Idempotency-Key"));
  res.status(result.processing ? 202 : 200).json(result);
});
export const documentFile = asyncRoute(async (req, res, next) => {
  const file = await getDocumentFile(req.user, parseOrThrow(documentParamsSchema, req.params).documentId);
  res.download(file.path, file.filename, (error) => { if (error && !res.headersSent) next(error); });
});
export const removeDocument = asyncRoute(async (req, res) => {
  const result = await deleteDocument(req.user, parseOrThrow(documentParamsSchema, req.params).documentId);
  res.json(result);
});
export const applicantsList = asyncRoute(async (req, res) => res.json(await listApplicants(req.user, query(req))));
export const applicantDetails = asyncRoute(async (req, res) => res.json(await getApplicant(req.user, parseOrThrow(applicantParamsSchema, req.params).applicantId)));
export const documentsList = asyncRoute(async (req, res) => res.json(await listDocuments(req.user, query(req))));
export const documentDetails = asyncRoute(async (req, res) => res.json(await getDocument(req.user, parseOrThrow(documentParamsSchema, req.params).documentId)));
export const decision = asyncRoute(async (req, res) => res.json(await getDecision(req.user, applicationId(req))));
export const referrals = asyncRoute(async (req, res) => res.json(await listReferrals(query(req))));
export const review = asyncRoute(async (req, res) => {
  const result = await reviewReferral(req.user, applicationId(req), parseOrThrow(reviewSchema, req.body), req.get("Idempotency-Key"));
  res.status(result.replayed ? 200 : 201).json(result.review);
});
export const audit = asyncRoute(async (req, res) => res.json(await getAudit(req.user, applicationId(req), query(req))));
export const rulebooks = asyncRoute(async (_req, res) => res.json(await listRulebooks()));
export const runAI = asyncRoute(async (req, res) => {
  const input = parseOrThrow(aiRunSchema, req.body);
  const execute = input.mode === "MANUAL_REVIEW" ? recordManualReview : rerunEligibility;
  res.json(await execute(req.user, input.applicationId, req.get("Idempotency-Key")));
});
export const notifications = asyncRoute(async (req, res) => res.json(await listNotifications(req.user, { limit: 20 })));
