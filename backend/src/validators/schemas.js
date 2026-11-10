import { z } from "zod";

const email = z.email().max(254);
const nonNegative = z.number().finite().min(0);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(10).max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});

export const applicationSchema = z.object({
  applicant: z.object({
    fullName: z.string().trim().min(1).max(120),
    email,
    phone: z.string().max(40).optional(),
    dateOfBirth: z.string().max(20).optional(),
    employment: z.string().max(160).optional(),
  }),
  loanAmount: z.number().finite().positive().max(100000000),
  loanTermMonths: z.number().int().positive().max(600),
  financial: z.object({
    monthlyGross: nonNegative.optional(),
    monthlyNet: nonNegative.optional(),
    monthlyObligations: nonNegative.optional(),
    incomeSource: z.string().max(100).optional(),
  }).optional(),
});

export const profileSchema = z.object({
  monthlyGross: nonNegative.nullable().optional(),
  monthlyNet: nonNegative.nullable().optional(),
  monthlyObligations: nonNegative.nullable().optional(),
  employment: z.string().max(160).nullable().optional(),
  incomeSource: z.string().max(100).nullable().optional(),
});

export const reviewSchema = z.object({
  outcome: z.enum(["APPROVED", "DECLINED", "MORE_INFORMATION"]),
  remarks: z.string().trim().min(1).max(2000),
  score: z.number().int().min(0).max(100).optional(),
});
export const aiRunSchema = z.object({
  applicationId: z.string().min(1).max(64),
  mode: z.enum(["ELIGIBILITY", "MANUAL_REVIEW"]).optional(),
});
export const applicationParamsSchema = z.object({ applicationId: z.string().min(1).max(64) });
export const applicantParamsSchema = z.object({ applicantId: z.string().min(1).max(64) });
export const documentParamsSchema = z.object({ documentId: z.string().min(1).max(64) });

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(40).optional(),
});
