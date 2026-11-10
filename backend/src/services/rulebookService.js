import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";

export async function activeRulebook() {
  const active = await prisma.eligibilityRule.findMany({ where: { active: true } });
  if (active.length !== 1) {
    throw new AppError(503, "RULEBOOK_UNAVAILABLE", "Exactly one active eligibility rulebook must be configured");
  }
  const [rule] = active;
  let config;
  try {
    config = JSON.parse(rule.config);
  } catch {
    throw new AppError(503, "RULEBOOK_INVALID", "The active eligibility rulebook configuration is invalid");
  }
  return { version: rule.version, config };
}

export async function listRulebooks() {
  const rules = await prisma.eligibilityRule.findMany({ orderBy: { createdAt: "desc" } });
  return {
    items: rules.map((rule) => {
      try {
        return { ...rule, config: JSON.parse(rule.config) };
      } catch {
        throw new AppError(503, "RULEBOOK_INVALID", `Eligibility rulebook ${rule.version} has invalid configuration`);
      }
    }),
    total: rules.length,
  };
}
