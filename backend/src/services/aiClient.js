import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const WRONG_AI_SERVICE_MESSAGE =
  "Document validation is not available: the AI service at AI_SERVICE_URL does not provide document checks. " +
  "Start the AI service from this project's aiservices folder (uvicorn app.main:app --port 8000).";

// Healthy only when the AI service is up AND it is this project's service
// (it must provide the document upload check, not just /health).
export async function checkAIHealth() {
  const base = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const data = await response.json();
    if (data.status !== "ok") return false;
    const probe = await fetch(`${base}/documents/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    return probe.status !== 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Asks the local AI service whether an upload is an ID proof, payslip, or bank
// statement that matches its upload slot. The check is deterministic (document
// text + structure rules) and runs before anything is saved. Scanned PDFs need
// OCR, so the timeout is generous.
export async function validateDocument({ content, filename, contentType, expectedDocumentType }) {
  const base = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.DOCUMENT_VALIDATION_TIMEOUT_MS || 180000),
  );
  const unavailable = () => new AppError(
    503,
    "DOCUMENT_VALIDATION_UNAVAILABLE",
    "Document validation is temporarily unavailable. Please try again later.",
  );
  try {
    const response = await fetch(`${base}/documents/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        encoded_document: content.toString("base64"),
        filename,
        content_type: contentType,
        ...(expectedDocumentType ? { expected_document_type: expectedDocumentType } : {}),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 404) {
      logger.error({ url: `${base}/documents/validate` }, "AI service has no document validation endpoint; wrong AI service running?");
      throw new AppError(503, "DOCUMENT_VALIDATION_UNAVAILABLE", WRONG_AI_SERVICE_MESSAGE);
    }
    if (response.status === 503) throw unavailable();
    if (!response.ok) {
      const message = typeof data?.detail === "string"
        ? data.detail
        : "The uploaded file could not be validated.";
      throw new AppError(422, "DOCUMENT_VALIDATION_FAILED", message);
    }
    if (typeof data?.valid !== "boolean") throw unavailable();
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorkflow({ text, filename, contentType, applicationId, documentId, loanAmount, rulebookVersion, rulebookConfig, expectedDocumentType }) {
  const base = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_WORKFLOW_TIMEOUT_MS || 300000));
  try {
    const response = await fetch(`${base}/workflow/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        encoded_document: text, filename, content_type: contentType, expected_document_type: expectedDocumentType,
        application_id: applicationId, document_id: documentId, loan_amount: loanAmount,
        rulebook_version: rulebookVersion, rulebook_config: rulebookConfig,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new AppError(502, "AI_SERVICE_ERROR", "AI service rejected document processing", data);
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "AI_SERVICE_UNAVAILABLE", "AI service is unavailable; document remains pending review");
  } finally {
    clearTimeout(timeout);
  }

}

// Deterministic eligibility (DTI + rulebook) in the AI service. With
// explain_with_llm the service may add a grounded LLM summary to the
// explanation; it falls back to its deterministic text if the model is busy.
export async function runEligibility({
  monthly_gross,
  monthly_net,
  monthly_obligations,
  loan_amount,
  rulebook_version,
  rulebook_config,
  manual_review_reason,
  declared_monthly_net,
  net_income_source,
  obligations_source,
  explain_with_llm = false,
}) {
  const base = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.AI_ELIGIBILITY_TIMEOUT_MS || (explain_with_llm ? 150000 : 15000)),
  );
  try {
    const response = await fetch(`${base}/eligibility/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        monthly_gross,
        monthly_net,
        monthly_obligations,
        loan_amount,
        rulebook_version,
        rulebook_config,
        ...(manual_review_reason ? { manual_review_reason } : {}),
        ...(declared_monthly_net != null ? { declared_monthly_net } : {}),
        ...(net_income_source ? { net_income_source } : {}),
        ...(obligations_source ? { obligations_source } : {}),
        explain_with_llm,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new AppError(502, "AI_SERVICE_ERROR", "Eligibility service rejected the financial profile", data);
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "AI_SERVICE_UNAVAILABLE", "Eligibility service is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
