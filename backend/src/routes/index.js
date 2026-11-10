import { Router } from "express";
import multer from "multer";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { authenticate, requireWritableRole, requireOfficer, requireAuditor } from "../middleware/auth.js";
import * as auth from "../controllers/authController.js";
import * as app from "../controllers/applicationController.js";
import { AppError } from "../utils/errors.js";
import { prisma } from "../data-access/prisma.js";
import { asyncRoute } from "../utils/errors.js";
import { checkAIHealth } from "../services/aiClient.js";

const router = Router();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
await mkdir(uploadDir, { recursive: true });
const uploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}${path.extname(_file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = file.mimetype === "application/pdf" &&
      path.extname(file.originalname).toLowerCase() === ".pdf";
    cb(allowed ? null : new AppError(400, "UNSUPPORTED_FILE", "Only PDF documents are supported"), allowed);
  },
});

router.post("/auth/register", auth.registerUser);

router.post("/auth/login", auth.loginUser);

router.get("/health", asyncRoute(async (_req, res) => {
  const aiAvailable = await checkAIHealth();
  res.status(aiAvailable ? 200 : 503).json({
    status: aiAvailable ? "ok" : "degraded",
    dependencies: { api: "ok", ai: aiAvailable ? "ok" : "unavailable" },
  });
}));
router.use(authenticate);
router.get("/dashboard", asyncRoute(async (req, res) => {
  const where = ["OFFICER", "AUDITOR"].includes(req.user.role) ? {} : { userId: req.user.sub };
  const records = await prisma.application.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { applicant: true, reviews: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const applications = records.slice(0, 5).map((application) => {
    const review = application.reviews[0];
    return review ? { ...application, status: review.outcome } : application;
  });
  const counts = {};
  for (const application of records) {
    const status = application.reviews[0]?.outcome || application.status;
    counts[status] = (counts[status] || 0) + 1;
  }
  res.json({
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    pending: (counts.PENDING || 0) + (counts.MORE_INFORMATION || 0),
    approved: (counts.ELIGIBLE || 0) + (counts.APPROVED || 0),
    rejected: (counts.NOT_ELIGIBLE || 0) + (counts.DECLINED || 0),
    referred: counts.REFER || 0,
    recent: applications,
  });
}));
router.get("/applications", app.list);
router.post("/applications", requireWritableRole, app.create);
router.get("/applications/:applicationId", app.details);
router.delete("/applications/:applicationId", requireWritableRole, app.removeApplication);
router.post("/applications/:applicationId/documents", requireWritableRole, uploader.single("file"), app.upload);
router.post("/applications/:applicationId/extract", requireWritableRole, app.extract);
router.patch("/applications/:applicationId/profile", requireWritableRole, app.profileUpdate);
router.get("/applications/:applicationId/decision", app.decision);
router.get("/eligibilityrules", app.rulebooks);
router.get("/applications/:applicationId/audit", requireAuditor, app.audit);
router.get("/applicants", app.applicantsList);
router.get("/applicants/:applicantId", app.applicantDetails);
router.get("/documents", app.documentsList);
router.delete("/documents/:documentId", requireWritableRole, app.removeDocument);
router.get("/documents/:documentId", app.documentDetails);
router.get("/documents/:documentId/file", app.documentFile);
router.get("/notifications", app.notifications);
router.get("/referrals", requireOfficer, app.referrals);
router.post("/referrals/:applicationId/review", requireOfficer, app.review);
router.post("/ai/run", requireWritableRole, app.runAI);

export default router;
