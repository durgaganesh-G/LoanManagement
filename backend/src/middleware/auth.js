import jwt from "jsonwebtoken";
import { AppError } from "../utils/errors.js";

export function authenticate(req, _res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return next(new AppError(401, "UNAUTHORIZED", "Authentication is required"));
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new AppError(401, "INVALID_TOKEN", "Authentication token is invalid or expired"));
  }
}

export function requireOfficer(req, _res, next) {
  if (req.user?.role !== "OFFICER") {
    return next(new AppError(403, "FORBIDDEN", "Officer access is required"));
  }
  next();
}

export function requireAuditor(req, _res, next) {
  if (req.user?.role !== "AUDITOR") {
    return next(new AppError(403, "FORBIDDEN", "Auditor access is required"));
  }
  next();
}

export function requireWritableRole(req, _res, next) {
  if (req.user?.role === "AUDITOR") {
    return next(new AppError(403, "READ_ONLY_ROLE", "Auditor access is read-only"));
  }
  if (!["APPLICANT", "OFFICER"].includes(req.user?.role)) {
    return next(new AppError(403, "FORBIDDEN", "This role cannot modify application records"));
  }
  next();
}
