import { createHash } from "node:crypto";
import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";

export async function beginOperation(userId, key, operation, payload, resumeInProgress = false) {
  if (!key || key.length > 128) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid Idempotency-Key header");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const where = { userId_key_operation: { userId, key, operation } };
  const existing = await prisma.idempotencyRecord.findUnique({ where });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
    if (existing.status === "COMPLETED") return { replayId: existing.resultId };
    if (resumeInProgress && existing.resultId) return { recordId: existing.id, resumeId: existing.resultId };
    throw new AppError(409, "REQUEST_IN_PROGRESS", "An operation with this Idempotency-Key is already in progress");
  }
  try {
    const record = await prisma.idempotencyRecord.create({ data: { userId, key, operation, requestHash } });
    return { recordId: record.id };
  } catch (error) {
    if (error.code !== "P2002") throw error;
    throw new AppError(409, "REQUEST_IN_PROGRESS", "An operation with this Idempotency-Key is already in progress");
  }
}

export async function completeOperation(recordId, resultId, database = prisma) {
  await database.idempotencyRecord.update({ where: { id: recordId }, data: { status: "COMPLETED", resultId } });
}

export async function cancelOperation(recordId) {
  await prisma.idempotencyRecord.delete({ where: { id: recordId } });
}
