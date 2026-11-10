import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../generated/postgres-client-runtime/index.js";

const prisma = new PrismaClient();
const password = process.env.DEMO_OFFICER_PASSWORD || "DemoPass123!";
const auditorPassword = process.env.DEMO_AUDITOR_PASSWORD || "DemoPass123!";
const samplePassword = process.env.DEMO_APPLICANT_PASSWORD || "DemoPass123!";
const samples = [
  { name: "Asha Sample", email: "asha.applicant@demo.local", amount: 12000, term: 36, gross: 5000, net: 4100, obligations: 1000, employment: "Salaried", source: "Synthetic payslip", outcome: "ELIGIBLE" },
  { name: "Ravi Example", email: "ravi.applicant@demo.local", amount: 9000, term: 24, gross: 4000, net: 3300, obligations: 1200, employment: "Salaried", source: "Synthetic payslip", outcome: "REFER" },
  { name: "Asha Sample", email: "asha.applicant@demo.local", amount: 18000, term: 48, gross: 7500, net: 6200, obligations: 0, employment: "Salaried", source: "Synthetic payslip", outcome: "ELIGIBLE" },
  { name: "Ravi Example", email: "ravi.applicant@demo.local", amount: 10000, term: 36, gross: 3000, net: 2500, obligations: 700, employment: "Contractor", source: "Synthetic bank statement", outcome: "ELIGIBLE" },
  { name: "Asha Sample", email: "asha.applicant@demo.local", amount: 15000, term: 36, gross: 5000, net: 4500, obligations: 1800, employment: "Salaried", source: "Synthetic payslip", outcome: "REFER" },
  { name: "Ravi Example", email: "ravi.applicant@demo.local", amount: 6000, term: 24, gross: 2000, net: 1700, obligations: 600, employment: "Self-employed", source: "Synthetic bank statement", outcome: "REFER" },
  { name: "Asha Sample", email: "asha.applicant@demo.local", amount: 16000, term: 48, gross: 6000, net: 4900, obligations: 1200, employment: "Salaried", source: "Synthetic payslip", outcome: "ELIGIBLE" },
  { name: "Ravi Example", email: "ravi.applicant@demo.local", amount: 11000, term: 36, gross: 5000, net: 4100, obligations: 2250, employment: "Salaried", source: "Synthetic payslip", outcome: "NOT_ELIGIBLE" },
  { name: "Asha Sample", email: "asha.applicant@demo.local", amount: 14000, term: 36, gross: 5000, net: 4000, obligations: 2500, employment: "Contractor", source: "Synthetic bank statement", outcome: "NOT_ELIGIBLE" },
  { name: "Ravi Example", email: "ravi.applicant@demo.local", amount: 20000, term: 60, gross: 7000, net: 5600, obligations: 4200, employment: "Salaried", source: "Synthetic payslip", outcome: "NOT_ELIGIBLE" },
];

try {
  const hash = await bcrypt.hash(password, 12);
  const auditorHash = await bcrypt.hash(auditorPassword, 12);
  const sampleHash = await bcrypt.hash(samplePassword, 12);
  await prisma.user.upsert({
    where: { email: "officer@bnk.local" },
    update: { passwordHash: hash, role: "OFFICER", name: "Demo Loan Officer" },
    create: { email: "officer@bnk.local", passwordHash: hash, role: "OFFICER", name: "Demo Loan Officer" },
  });
  await prisma.user.upsert({
    where: { email: "auditor@bnk.local" },
    update: { passwordHash: auditorHash, role: "AUDITOR", name: "Demo Credit Risk Auditor" },
    create: { email: "auditor@bnk.local", passwordHash: auditorHash, role: "AUDITOR", name: "Demo Credit Risk Auditor" },
  });
  const sampleUsers = new Map();
  for (const [index, email] of ["asha.applicant@demo.local", "ravi.applicant@demo.local"].entries()) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash: sampleHash, role: "APPLICANT", name: index === 0 ? "Asha Sample" : "Ravi Example" },
      create: { email, passwordHash: sampleHash, role: "APPLICANT", name: index === 0 ? "Asha Sample" : "Ravi Example" },
    });
    sampleUsers.set(email, user);
  }
  await prisma.eligibilityRule.upsert({
    where: { version: "DEMO-1" },
    update: { config: JSON.stringify({ eligibleBelowDti: 35, notEligibleAboveDti: 40 }), active: true },
    create: { version: "DEMO-1", config: JSON.stringify({ eligibleBelowDti: 35, notEligibleAboveDti: 40 }), active: true },
  });

  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  await mkdir(uploadDir, { recursive: true });
  for (const [index, sample] of samples.entries()) {
    const number = String(index + 1).padStart(3, "0");
    const user = sampleUsers.get(sample.email);
    const applicationNo = `BNK-DEMO-${number}`;
    const text = `SYNTHETIC DEMO DOCUMENT ${number}\nMonthly gross income: ${sample.gross} per month.\nMonthly net income: ${sample.net} per month.\nExisting monthly debt obligations: ${sample.obligations} per month.\nEmployment: ${sample.employment}.\n`;
    const evidence = {
      monthly_gross: { source: `synthetic-document-${number}.txt`, quote: `Monthly gross income: ${sample.gross} per month.` },
      monthly_net: { source: `synthetic-document-${number}.txt`, quote: `Monthly net income: ${sample.net} per month.` },
      monthly_obligations: { source: `synthetic-document-${number}.txt`, quote: `Existing monthly debt obligations: ${sample.obligations} per month.` },
    };
    const application = await prisma.application.upsert({
      where: { applicationNo },
      update: { status: sample.outcome, loanAmount: sample.amount, loanTermMonths: sample.term, userId: user.id },
      create: {
        applicationNo,
        status: sample.outcome,
        loanAmount: sample.amount,
        loanTermMonths: sample.term,
        idempotencyKey: `seed-demo-${number}`,
        requestHash: `seed-demo-${number}`,
        userId: user.id,
      },
    });
    await prisma.applicant.upsert({
      where: { applicationId: application.id },
      update: { fullName: sample.name, email: `applicant-${number}@example.test`, employment: sample.employment },
      create: { applicationId: application.id, fullName: sample.name, email: `applicant-${number}@example.test`, employment: sample.employment },
    });
    await prisma.income.upsert({
      where: { applicationId: application.id },
      update: {
        monthlyGross: sample.gross, monthlyNet: sample.net, monthlyObligations: sample.obligations,
        employment: sample.employment, incomeSource: sample.source, evidence: JSON.stringify(evidence),
        originalValues: JSON.stringify({ monthlyGross: sample.gross, monthlyNet: sample.net, monthlyObligations: sample.obligations }),
        correctedValues: JSON.stringify({}),
      },
      create: {
        applicationId: application.id,
        monthlyGross: sample.gross,
        monthlyNet: sample.net,
        monthlyObligations: sample.obligations,
        employment: sample.employment,
        incomeSource: sample.source,
        evidence: JSON.stringify(evidence),
        originalValues: JSON.stringify({ monthlyGross: sample.gross, monthlyNet: sample.net, monthlyObligations: sample.obligations }),
        correctedValues: JSON.stringify({}),
      },
    });

    const storedName = `synthetic-document-${number}.txt`;
    await writeFile(path.join(uploadDir, storedName), text, "utf8");
    const document = await prisma.document.findFirst({ where: { applicationId: application.id, storedName } });
    const documentData = {
      originalName: `Synthetic ${sample.source.toLowerCase()} ${number}.txt`,
      storedName,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(text),
      status: "PROCESSED",
      extractedText: text,
      extractedValues: JSON.stringify({ ...evidence, monthly_gross: sample.gross, monthly_net: sample.net, monthly_obligations: sample.obligations }),
      extractionError: null,
    };
    if (document) await prisma.document.update({ where: { id: document.id }, data: documentData });
    else await prisma.document.create({ data: { applicationId: application.id, ...documentData } });

    const dtiPercent = Math.round((sample.obligations / sample.net) * 10000) / 100;
    const rulesTriggered = sample.outcome === "ELIGIBLE"
      ? ["DEMO_DTI_WITHIN_ELIGIBLE_THRESHOLD"]
      : sample.outcome === "REFER"
        ? ["DEMO_DTI_IN_REVIEW_BAND", "BORDERLINE_DTI"]
        : ["DEMO_DTI_ABOVE_NOT_ELIGIBLE_THRESHOLD"];
    const decisionData = {
      outcome: sample.outcome,
      dtiPercent,
      rulesTriggered: JSON.stringify(rulesTriggered),
      rulebookVersion: "DEMO-1",
      explanation: `Outcome: ${sample.outcome}. Monthly net income: ${sample.net}; monthly obligations: ${sample.obligations}; DTI using net income: ${dtiPercent}%. Rules: ${rulesTriggered.join(", ")}. Rulebook: DEMO-1. Synthetic demonstration only.`,
    };
    const priorDecision = await prisma.decision.findFirst({ where: { applicationId: application.id }, orderBy: { createdAt: "desc" } });
    if (priorDecision) await prisma.decision.update({ where: { id: priorDecision.id }, data: decisionData });
    else await prisma.decision.create({ data: { applicationId: application.id, ...decisionData } });

    const priorAudit = await prisma.auditLog.findFirst({ where: { applicationId: application.id, action: "SYNTHETIC_SAMPLE_SEEDED" } });
    if (!priorAudit) {
      await prisma.auditLog.create({
        data: { applicationId: application.id, actorId: user.id, action: "SYNTHETIC_SAMPLE_SEEDED", details: JSON.stringify({ outcome: sample.outcome, rulebookVersion: "DEMO-1" }) },
      });
    }
  }
  console.log(`Seed complete: demo officer, read-only auditor, and ${samples.length} synthetic applications (4 eligible, 3 referred, 3 not eligible).`);
} finally {
  await prisma.$disconnect();
}
