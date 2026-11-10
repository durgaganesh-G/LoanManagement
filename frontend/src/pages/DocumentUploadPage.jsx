import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { DocumentStatus, ErrorState, Loading } from "../components/States";
import useIdempotencyKey from "../hooks/useIdempotencyKey";
import { latestRequiredDocuments } from "../utils/documentReadiness";

const REQUIRED_DOCUMENTS = [
  { id: "aadhaar", title: "ID proof", description: "Upload a PDF of your ID proof (Aadhaar, PAN card, passport or voter ID).", matches: /aadhaar|aadhar|adhar|id[\s_-]?proof|identity[\s_-]?proof/i },
  { id: "payslips", title: "Payslips", description: "Upload payslip PDFs covering the latest three months. You can select multiple files.", matches: /pay[\s_-]?slips?|salary[\s_-]?slips?/i },
  { id: "bank-statements", title: "Bank statements", description: "Upload bank statement PDFs covering the latest three months. You can select multiple files.", matches: /bank.*statement|statement.*bank/i },
];

function parsedExtractedValues(document) {
  if (!document?.extractedValues) return {};
  if (typeof document.extractedValues !== "string") return document.extractedValues;
  try {
    return JSON.parse(document.extractedValues);
  } catch {
    return {};
  }
}

function getUploadValidation(document) {
  return parsedExtractedValues(document).upload_validation || null;
}

function documentTypeLabel(documentType) {
  return {
    aadhaar: "ID proof",
    payslips: "payslip",
    "bank-statements": "bank statement",
  }[documentType] || "unsupported document";
}

function isWrongDocumentType(document) {
  const extracted = parsedExtractedValues(document);
  return document?.status === "NEEDS_REVIEW" &&
    ["payslips", "bank-statements"].includes(extracted.document_type) &&
    extracted.document_verification?.field === "income_document_type" &&
    extracted.document_verification?.status === "FAILED";
}

function firstFailurePerDocument(failures = []) {
  const first = new Map();
  for (const failure of failures || []) {
    if (!first.has(failure.documentType)) first.set(failure.documentType, failure);
  }
  return [...first.values()];
}

export default function DocumentUploadPage() {
  const { applicationId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const idempotencyKey = useIdempotencyKey();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["application", applicationId],
    queryFn: async () => (await api.get(`/applications/${applicationId}`)).data,
    refetchInterval: (query) => query.state.data?.documents?.some((document) => document.status === "PROCESSING") ? 2000 : false,
  });
  const fileInput = useRef(null);
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNoticeState] = useState({ text: "", tone: "info" });
  const setNotice = (text, tone = "info") => setNoticeState({ text, tone });
  const [busy, setBusy] = useState(false);
  const [removingDocumentId, setRemovingDocumentId] = useState(null);
  const [extractBusy, setExtractBusy] = useState(false);
  const [replacementRequirementId, setReplacementRequirementId] = useState(null);

  const documentList = data?.documents || [];
  const extracting = documentList.some((document) => document.status === "PROCESSING");

  useEffect(() => {
    setFiles([]);
    setNoticeState({ text: "", tone: "info" });
    setReplacementRequirementId(null);
  }, [applicationId]);

  // Extraction + verification for the given documents (all three required
  // documents are checked together so names and income can be compared).
  async function startExtraction(documentIds) {
    if (!documentIds.length) return;
    setExtractBusy(true);
    try {
      const { data: result } = await api.post(`/applications/${applicationId}/extract`, {}, {
        headers: { "Idempotency-Key": idempotencyKey(`extract:${applicationId}`, documentIds) },
      });
      if (!Array.isArray(result?.documentIds) || !result.documentIds.length) {
        throw new Error("The document check did not start. Please try again.");
      }
      await client.invalidateQueries({ queryKey: ["application", applicationId] });
    } catch (issue) {
      setNotice(issue?.response ? errorMessage(issue) : issue?.message || errorMessage(issue), "error");
    } finally {
      setExtractBusy(false);
    }
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={errorMessage(error)} retry={refetch} />;

  const latestDocuments = latestRequiredDocuments(documentList);
  const completed = {};
  for (const requirement of REQUIRED_DOCUMENTS) {
    const document = latestDocuments.get(requirement.id);
    if (document) completed[requirement.id] = { fileName: document.originalName, documentId: document.id, status: document.status };
  }
  const completedCount = REQUIRED_DOCUMENTS.filter(({ id }) => completed[id]).length;
  const progress = Math.round((completedCount / REQUIRED_DOCUMENTS.length) * 100);
  const currentRequirement = REQUIRED_DOCUMENTS.find(({ id }) => id === replacementRequirementId) ||
    REQUIRED_DOCUMENTS.find(({ id }) => !latestDocuments.has(id));
  const uploadedRequiredDocuments = [...latestDocuments.values()];
  const allDocumentsUploaded = REQUIRED_DOCUMENTS.every(({ id }) => latestDocuments.has(id));
  const extractionFinished = allDocumentsUploaded && !extracting &&
    uploadedRequiredDocuments.every((document) => ["PROCESSED", "NEEDS_REVIEW"].includes(document.status));
  const canExtract = uploadedRequiredDocuments.length > 0 && !extracting &&
    uploadedRequiredDocuments.some((document) => document.status === "UPLOADED");
  const readiness = data.workflow;

  function addFiles(selectedFiles) {
    const pdfFiles = [];
    const unsupportedFiles = [];
    for (const selected of selectedFiles) {
      if (
        !selected.name.toLowerCase().endsWith(".pdf")
        || (selected.type && selected.type !== "application/pdf")
      ) {
        unsupportedFiles.push(selected.name);
      } else {
        pdfFiles.push(selected);
      }
    }

    setNotice(unsupportedFiles.length
      ? `Only PDF documents are supported. Not added: ${unsupportedFiles.join(", ")}.`
      : "", "error");
    if (!pdfFiles.length) return;

    setFiles((previous) => {
      const next = [...previous];
      for (const selected of pdfFiles) {
        const alreadyQueued = next.some((item) =>
          item.name === selected.name && item.size === selected.size && item.lastModified === selected.lastModified);
        if (!alreadyQueued) next.push(selected);
      }
      return next;
    });
  }

  async function submit(event) {
    event.preventDefault();
    if (!files.length || !currentRequirement) return;
    const requirementId = currentRequirement.id;
    setBusy(true);
    setNotice("");
    let uploadedCount = 0;
    const validations = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const selected = files[index];
        const body = new FormData();
        body.append("documentType", requirementId);
        body.append("file", selected);
        const fileKey = {
          documentType: requirementId,
          filename: selected.name,
          size: selected.size,
          lastModified: selected.lastModified,
        };
        const { data: result } = await api.post(`/applications/${applicationId}/documents`, body, {
          headers: { "Content-Type": "multipart/form-data", "Idempotency-Key": idempotencyKey(applicationId, fileKey) },
          timeout: 240000,
        });
        if (!result.document?.id) throw new Error(result.error?.message || `The upload of ${selected.name} was not saved.`);
        if (!result.documentValidation?.valid) {
          throw new Error("Document validation did not return a valid result. Please try again.");
        }
        validations.push(result.documentValidation);
        uploadedCount += 1;

        client.setQueryData(["application", applicationId], (previous) => previous ? {
          ...previous,
          documents: [
            ...(previous.documents || []).filter((document) => document.id !== result.document.id),
            result.document,
          ],
        } : previous);
      }

      setNotice(uploadedCount === 1
        ? `Valid ${documentTypeLabel(validations[0].document_type)} detected.`
        : `Validated and uploaded ${uploadedCount} ${documentTypeLabel(validations[0].document_type)} documents.`, "success");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setReplacementRequirementId(null);
      await client.invalidateQueries({ queryKey: ["application", applicationId] });

      // Once the ID proof, payslip and bank statement are all in, check them
      // straight away: extraction, verification and cross-document matching.
      const current = client.getQueryData(["application", applicationId]);
      const latestNow = latestRequiredDocuments(current?.documents || []);
      const documentsNow = [...latestNow.values()];
      if (
        REQUIRED_DOCUMENTS.every(({ id }) => latestNow.has(id)) &&
        documentsNow.some((document) => document.status === "UPLOADED") &&
        !documentsNow.some((document) => document.status === "PROCESSING")
      ) {
        await startExtraction(documentsNow.map(({ id }) => id));
      }
    } catch (issue) {
      setFiles((previous) => previous.slice(uploadedCount));
      const rejected = issue?.response?.data?.code === "DOCUMENT_VALIDATION_REJECTED";
      setNotice(rejected ? `Document not accepted. ${errorMessage(issue)}` : errorMessage(issue), "error");
      await client.invalidateQueries({ queryKey: ["application", applicationId] });
    } finally {
      setBusy(false);
    }
  }

  async function extractDocuments() {
    const documentIds = REQUIRED_DOCUMENTS.map(({ id }) => latestDocuments.get(id)?.id).filter(Boolean);
    if (!canExtract || !documentIds.length) return;
    setNotice("");
    await startExtraction(documentIds);
  }

  async function removeDocument(document) {
    if (!window.confirm(`Remove "${document.originalName}" from this application?`)) return;
    setRemovingDocumentId(document.id);
    setNotice("");
    try {
      await api.delete(`/documents/${document.id}`);
      client.setQueryData(["application", applicationId], (previous) => previous ? {
        ...previous,
        documents: (previous.documents || []).filter((item) => item.id !== document.id),
      } : previous);
      await client.invalidateQueries({ queryKey: ["application", applicationId] });
    } catch (issue) {
      setNotice(errorMessage(issue), "error");
      await client.invalidateQueries({ queryKey: ["application", applicationId] });
    } finally {
      setRemovingDocumentId(null);
    }
  }

  return <div>
    <div className="breadcrumb"><Link to={`/applications/${applicationId}`}>{data.applicationNo}</Link><span>/</span><span>Documents</span></div>
    <div className="page-heading"><div><p className="eyebrow">DOCUMENTS · {completedCount} OF {REQUIRED_DOCUMENTS.length} UPLOADED</p><h1>Supporting documents</h1><p className="muted">Upload the ID Proof, payslip, and bank statement, then extract and verify them together.</p></div></div>

    <section className="panel document-progress-panel" aria-label="Required document progress">
      <div className="document-progress-heading"><div><p className="eyebrow">APPLICATION CHECKLIST</p><h2>{completedCount === REQUIRED_DOCUMENTS.length ? "All documents received" : "Your document checklist"}</h2></div><b>{progress}%</b></div>
      <div className="document-progress-track" role="progressbar" aria-label="Document upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="required-document-grid">
        {REQUIRED_DOCUMENTS.map((requirement, index) => {
          const item = completed[requirement.id];
          const isComplete = Boolean(item);
          const isCurrent = currentRequirement?.id === requirement.id;
          const latestDocument = latestDocuments.get(requirement.id);
          const wrongDocumentType = isWrongDocumentType(latestDocument);
          const documentVerified = latestDocument?.status === "PROCESSED" &&
            (() => {
              const values = latestDocument.extractedValues;
              if (!values) return false;
              try {
                return (typeof values === "string" ? JSON.parse(values) : values).document_verification?.status === "VERIFIED";
              } catch {
                return false;
              }
            })();
          return <div className={`required-document${isComplete ? " is-complete" : ""}${isCurrent ? " is-current" : ""}`} key={requirement.id}>
            <span className="required-document-number" aria-hidden="true">{isComplete ? "✓" : `0${index + 1}`}</span>
            <div><b>{requirement.title}</b><small>{item?.fileName || (isCurrent ? "Ready to upload" : "Waiting for previous document")}</small></div>
            <span className="required-document-status">{wrongDocumentType ? "Wrong document type" : latestDocument?.status === "PROCESSING" ? "Extracting" : documentVerified ? "Verified" : latestDocument?.status === "NEEDS_REVIEW" ? "Needs review" : latestDocument?.status === "UPLOADED" ? "Awaiting verification" : isComplete ? "Uploaded" : "Pending"}</span>
            {latestDocument && latestDocument.status !== "PROCESSING" && <button type="button" className="button secondary" onClick={() => setReplacementRequirementId(requirement.id)} aria-label={`Replace ${requirement.title}`}>Replace</button>}
          </div>;
        })}
      </div>
    </section>

    {currentRequirement ? <form className="panel upload-panel required-upload-panel" onSubmit={submit}>
      <div className="panel-heading"><div><p className="eyebrow">STEP {completedCount + 1} OF {REQUIRED_DOCUMENTS.length}</p><h2>{replacementRequirementId === currentRequirement.id ? `Replace ${currentRequirement.title}` : currentRequirement.title}</h2><p className="muted">{currentRequirement.description} Previous uploads are kept in the application history.</p></div><span className="upload-step-percent">+{Math.round(100 / REQUIRED_DOCUMENTS.length)}%</span></div>
      <label className={`drop-area${dragging ? " is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files || [])); }}>
        <span className="upload-icon" aria-hidden="true">↑</span><b>Drop files here, or <span className="drop-browse">browse files</span></b><span>PDF only · 10 MB maximum per file</span><input ref={fileInput} type="file" multiple accept=".pdf,application/pdf" onChange={(event) => addFiles(Array.from(event.target.files || []))} aria-label="Select documents" />
      </label>
      {files.map((selected, index) => <div className="selected-file-card" key={`${selected.name}-${selected.size}-${selected.lastModified}`}><span className="file-icon" aria-hidden="true">▤</span><div><b>{selected.name}</b><small>{(selected.size / 1024).toFixed(0)} KB · Ready to upload</small></div><button type="button" className="remove-file" aria-label={`Remove selected ${selected.name}`} disabled={busy} onClick={() => setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index))}>×</button></div>)}
      {notice.text && <p role={notice.tone === "error" ? "alert" : "status"} className={`notice notice-${notice.tone}`}>{notice.text}</p>}
      <button disabled={busy || !files.length} className="button primary upload-submit">{busy ? <><span className="button-spinner" aria-hidden="true" /> Checking {files.length === 1 ? "document" : `${files.length} documents`}...</> : files.length > 1 ? `Upload ${files.length} documents` : "Upload document"}{!busy && <span aria-hidden="true">→</span>}</button>
    </form> : null}
    {!currentRequirement && notice.text && <p role={notice.tone === "error" ? "alert" : "status"} className={`notice notice-${notice.tone}`}>{notice.text}</p>}
    {canExtract && !extractBusy && <section className="panel documents-complete-panel"><span className="documents-complete-icon" aria-hidden="true">✓</span><div><h2>All required documents are uploaded</h2><p className="muted">Check the documents to extract and verify their details.</p></div><button className="button primary" onClick={extractDocuments} disabled={extractBusy}>Extract Documents</button></section>}
    {(extracting || extractBusy) && <section className="panel documents-complete-panel documents-checking-panel" role="status">
      <span className="button-spinner" aria-hidden="true" />
      <div><h2>Checking your documents</h2><p className="muted">Reading the ID proof, payslip and bank statement, extracting the details and verifying them against each other. This page updates by itself.</p></div>
    </section>}
    {extractionFinished && !extractBusy && (readiness?.ready
      ? <section className="panel documents-complete-panel documents-verified-panel" role="status">
        <span className="documents-complete-icon" aria-hidden="true">✓</span>
        <div><h2>All documents verified</h2><p className="muted">Your ID proof, payslip and bank statement passed every check. Continue to review the verified figures and run eligibility.</p></div>
        <div className="form-actions">
          <button className="button primary" onClick={() => navigate(`/applications/${applicationId}/profile`)}>Continue to next step<span aria-hidden="true"> →</span></button>
        </div>
      </section>
      : <section className="panel documents-error-panel" role="alert">
        <div><h2>Some uploaded documents are not correct</h2><p>Please check the documents below. Replace the incorrect ones and they will be checked again automatically.</p></div>
        <ul>{firstFailurePerDocument(readiness?.failures).map((failure) => <li key={failure.documentType}><b>{REQUIRED_DOCUMENTS.find(({ id }) => id === failure.documentType)?.title || "Document"}:</b> {failure.reason}</li>)}</ul>
        <div className="form-actions">
          <button className="button secondary" onClick={() => navigate(`/applications/${applicationId}/profile`)}>Review details</button>
        </div>
      </section>)}

    <section className="panel"><div className="panel-heading"><div><p className="eyebrow">APPLICATION FILES</p><h2>Uploaded documents</h2></div></div>
      {data.documents?.length ? <div className="document-list">{data.documents.map((document) => {
        const wrongDocumentType = isWrongDocumentType(document);
        const validation = getUploadValidation(document);
        return <div className="document-row" key={document.id}><span className="file-icon">▤</span><div><b>{document.originalName}</b><small>{document.mimeType} · {(document.sizeBytes / 1024).toFixed(0)} KB{wrongDocumentType && <span className="document-error"> {document.extractionError || "This file does not match the selected document type. Remove it and upload the correct document."}</span>}</small>{validation && <small className="document-validation-status">Document check: {validation.valid ? "Valid" : "Invalid"} · {documentTypeLabel(validation.document_type)}</small>}</div><DocumentStatus status={document.status} invalidDocumentType={wrongDocumentType} /><button type="button" className="button secondary" onClick={() => removeDocument(document)} disabled={removingDocumentId === document.id} aria-label={`Remove ${document.originalName}`}>{removingDocumentId === document.id ? "Removing..." : "Remove"}</button></div>;
      })}</div> : <p className="muted">No files have been uploaded.</p>}
    </section>
  </div>;
}
