import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";

const staffRoles = ["OFFICER", "AUDITOR"];

const applicationSummary = {
  select: { id: true, applicationNo: true, status: true, loanAmount: true, loanTermMonths: true, createdAt: true, userId: true },
};

export async function listApplicants(user, { page, limit }) {
  const where = staffRoles.includes(user.role) ? {} : { application: { userId: user.sub } };
  const [items, total] = await Promise.all([
    prisma.applicant.findMany({
      where,
      include: { application: applicationSummary },
      orderBy: { application: { createdAt: "desc" } },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.applicant.count({ where }),
  ]);
  return { items, page, limit, total };
}

export async function getApplicant(user, id) {
  const applicant = await prisma.applicant.findFirst({
    where: { id },
    include: { application: applicationSummary },
  });
  if (!applicant) throw new AppError(404, "APPLICANT_NOT_FOUND", "Applicant not found");
  if (!staffRoles.includes(user.role) && applicant.application.userId !== user.sub) {
    throw new AppError(403, "FORBIDDEN", "Applicant does not belong to the caller");
  }
  return applicant;
}
