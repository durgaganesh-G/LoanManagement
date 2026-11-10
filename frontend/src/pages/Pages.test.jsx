import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { StatusBadge } from "../components/States";
import { AuthProvider } from "../context/AuthContext";
import AppLayout from "../layouts/AppLayout";
import ApplicationsPage from "./ApplicationsPage";
import AuditPage from "./AuditPage";
import DashboardPage from "./DashboardPage";
import DecisionPage from "./DecisionPage";
import DocumentUploadPage from "./DocumentUploadPage";
import EligibilityPage from "./EligibilityPage";
import ExtractedProfilePage from "./ExtractedProfilePage";
import NewApplicationPage from "./NewApplicationPage";
import ReferralsPage from "./ReferralsPage";

vi.mock("../api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  errorMessage: (error) => error?.response?.data?.message || "Unable to complete this request. Please try again.",
}));

describe("status badges", () => {
  it.each([
    ["ELIGIBLE", "eligible"],
    ["DECLINED", "declined"],
    ["REFER", "refer"],
    ["PENDING", "pending"],
  ])("maps %s to its status class", (value, statusClass) => {
    const { container } = render(<StatusBadge value={value} />);
    expect(container.querySelector(".badge")).toHaveClass(statusClass);
  });
});

function renderPage(path, route, element, state) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[state ? { pathname: path, state } : path]}>
          <Routes><Route path={route} element={element} /><Route path="/applications/:applicationId" element={<p>Application created</p>} /><Route path="/applications/:applicationId/profile" element={<p>Profile results</p>} /><Route path="/applications/:applicationId/eligibility" element={<p>Eligibility page</p>} /><Route path="/applications/:applicationId/decision" element={<p>Decision explanation</p>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

function documentValidation(documentType = "aadhaar") {
  const label = {
    aadhaar: "ID proof",
    payslips: "payslip",
    "bank-statements": "bank statement",
  }[documentType];
  return {
    valid: true,
    document_type: documentType,
    message: `Valid ${label} detected.`,
    matched_indicators: [],
  };
}

describe("application screens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storedValues = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => storedValues.get(key) ?? null,
      setItem: (key, value) => storedValues.set(key, String(value)),
      removeItem: (key) => storedValues.delete(key),
      clear: () => storedValues.clear(),
    });

    vi.stubGlobal("crypto", { randomUUID: () => "test-idempotency-key" });
  });

  it("submits a validated application with entered financial values", async () => {
    api.post.mockResolvedValueOnce({ data: { id: "app-1" } });
    renderPage("/applications/new", "/applications/new", <NewApplicationPage />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Applicant One" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "one@example.test" } });
    fireEvent.change(screen.getByLabelText("Requested amount ($)"), { target: { value: "12000" } });
    fireEvent.change(screen.getByLabelText("Loan term (months)"), { target: { value: "36" } });
    fireEvent.change(screen.getByLabelText(/Monthly gross income/), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText(/Monthly net income/), { target: { value: "4000" } });
    fireEvent.change(screen.getByLabelText(/Existing monthly obligations/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /Create application/ }));
    await waitFor(() => expect(screen.getByText("Application created")).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith("/applications", expect.objectContaining({
      loanAmount: 12000,
      loanTermMonths: 36,
      financial: { monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000 },
    }), expect.objectContaining({ headers: { "Idempotency-Key": "test-idempotency-key" } }));
  });

  it.each([
    ["APPLICANT", "Customer One", "Applicant"],
    ["OFFICER", "Officer One", "Loan officer"],
    ["AUDITOR", "Auditor One", "Credit risk / audit"],
  ])("opens the %s profile menu with name and email, and signs out", async (role, name, roleLabel) => {
    localStorage.setItem("bnk-token", "session-token");
    localStorage.setItem("bnk-user", JSON.stringify({ id: `user-${role}`, role, name, email: `${role.toLowerCase()}@example.test` }));
    api.get.mockResolvedValue({ data: { items: [] } });
    render(
      <AuthProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<p>Workspace</p>} />
              </Route>
              <Route path="/login" element={<p>Login page</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open profile menu" }));
    const profile = within(screen.getByRole("dialog", { name: "Profile" }));
    expect(profile.getByText(name)).toBeInTheDocument();
    expect(profile.getByText(`${role.toLowerCase()}@example.test`)).toBeInTheDocument();
    expect(profile.getByText(roleLabel)).toBeInTheDocument();

    fireEvent.click(profile.getByRole("button", { name: /Sign out/ }));

    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(localStorage.getItem("bnk-token")).toBeNull();
    expect(localStorage.getItem("bnk-user")).toBeNull();
  });

  it("shows unread notifications, marks them read when opened, and links to the item", async () => {
    localStorage.setItem("bnk-token", "session-token");
    localStorage.setItem("bnk-user", JSON.stringify({ id: "user-1", role: "APPLICANT", name: "Customer One", email: "one@example.test" }));
    const now = new Date().toISOString();
    api.get.mockImplementation(async (url) => (url === "/notifications" ? { data: { items: [
      { id: "n1", tone: "success", title: "Eligibility result: BNK-123", message: "Eligible under rulebook DEMO-1 (DTI 20%).", link: "/applications/app-1/decision", createdAt: now },
      { id: "n2", tone: "warning", title: "Documents need attention: BNK-124", message: "Payslip: Payslip net salary is missing or unreadable.", link: "/applications/app-2/documents", createdAt: now },
    ] } } : { data: {} }));
    render(
      <AuthProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<p>Workspace</p>} />
                <Route path="/applications/:applicationId/decision" element={<p>Decision page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    const panel = within(screen.getByRole("dialog", { name: "Notifications" }));
    expect(panel.getByText("Eligible under rulebook DEMO-1 (DTI 20%).")).toBeInTheDocument();
    expect(panel.getByText("Payslip: Payslip net salary is missing or unreadable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();

    fireEvent.click(panel.getByText("Eligibility result: BNK-123"));
    expect(await screen.findByText("Decision page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
  });

  it("shows an empty notification list and closes it with Escape", async () => {
    localStorage.setItem("bnk-token", "session-token");
    localStorage.setItem("bnk-user", JSON.stringify({ id: "user-2", role: "OFFICER", name: "Officer One", email: "officer@example.test" }));
    api.get.mockResolvedValue({ data: { items: [] } });
    render(
      <AuthProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes><Route element={<AppLayout />}><Route index element={<p>Workspace</p>} /></Route></Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText(/No notifications yet/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument());
  });

  it("saves uploads before explicit document extraction", async () => {
    api.get.mockResolvedValue({ data: { id: "app-1", applicationNo: "BNK-123", documents: [] } });
    api.post.mockResolvedValueOnce({ data: {
      document: { id: "document-1", status: "UPLOADED", originalName: "paystub.pdf", extractedValues: "{\"document_type\":\"aadhaar\"}" },
      documentValidation: documentValidation("aadhaar"),
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);
    const file = new File(["%PDF-1.4 source"], "paystub.pdf", { type: "application/pdf" });
    fireEvent.change(await screen.findByLabelText(/Select documents/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Valid ID proof detected."));
    expect(api.post).toHaveBeenCalledWith(
      "/applications/app-1/documents", expect.any(FormData),
      expect.objectContaining({ timeout: 240000 }),
    );
    expect(api.post.mock.calls[0][1].get("documentType")).toBe("aadhaar");
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("only queues PDF uploads and explains unsupported file types", async () => {
    api.get.mockResolvedValue({ data: { id: "app-1", applicationNo: "BNK-123", documents: [] } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    const input = await screen.findByLabelText("Select documents");
    expect(input).toHaveAttribute("accept", ".pdf,application/pdf");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "identity.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only PDF documents are supported. Not added: identity.png.",
    );
    expect(screen.getByRole("button", { name: /Upload document/ })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps a successfully uploaded document staged until extraction is requested", async () => {
    const document = {
      id: "document-review",
      originalName: "sample-aadhaar.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1200,
      status: "UPLOADED",
      extractedValues: JSON.stringify({ upload_validation: documentValidation("aadhaar") }),
    };
    let documents = [];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    api.post.mockImplementationOnce(async () => {
      documents = [document];
      return { data: { document, documentValidation: documentValidation("aadhaar") } };
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);
    fireEvent.change(await screen.findByLabelText("Select documents"), {
      target: { files: [new File(["sample"], "sample-aadhaar.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));

    expect(await screen.findByText("Valid ID proof detected.")).toBeInTheDocument();
    expect(screen.getByText("Document check: Valid · ID proof")).toBeInTheDocument();
    expect(screen.getByText("Awaiting verification", { selector: ".required-document-status" })).toBeInTheDocument();
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extract Documents" })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("shows the upload-gate rejection without treating the document as uploaded", async () => {
    api.get.mockResolvedValue({ data: { id: "app-1", applicationNo: "BNK-123", documents: [] } });
    api.post.mockRejectedValueOnce({
      response: {
        data: {
          code: "DOCUMENT_VALIDATION_REJECTED",
          message: "This PDF is not an ID proof, payslip, or bank statement. Only these three documents are accepted.",
        },
      },
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);
    fireEvent.change(await screen.findByLabelText("Select documents"), {
      target: { files: [new File(["car"], "car.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document not accepted. This PDF is not an ID proof, payslip, or bank statement. Only these three documents are accepted.",
    );
    expect(screen.queryByText("car.pdf", { selector: ".document-row b" })).not.toBeInTheDocument();
  });

  it("shows a retryable message when document validation is unavailable", async () => {
    api.get.mockResolvedValue({ data: { id: "app-1", applicationNo: "BNK-123", documents: [] } });
    api.post.mockRejectedValueOnce({
      response: {
        data: {
          message: "Document validation is temporarily unavailable. Please try again later.",
        },
      },
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);
    fireEvent.change(await screen.findByLabelText("Select documents"), {
      target: { files: [new File(["pdf"], "payslip.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document validation is temporarily unavailable. Please try again later.",
    );
    expect(screen.queryByText("payslip.pdf", { selector: ".document-row b" })).not.toBeInTheDocument();
  });

  it("tracks three required document uploads and checks them automatically", async () => {
    let documents = [];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    api.post.mockImplementation(async (url, body) => {
      if (url.endsWith("/extract")) {
        documents = documents.map((document) => ({ ...document, status: "PROCESSING" }));
        return { data: { applicationId: "app-1", documentIds: documents.map(({ id }) => id), processing: true } };
      }
      const file = body.get("file");
      const document = {
        id: `document-${api.post.mock.calls.length}`,
        originalName: file.name,
        status: "UPLOADED",
        extractedValues: JSON.stringify({ document_type: body.get("documentType") }),
        ...(file.name.includes("payslips") || file.name.includes("bank-statement")
          ? { extractedValues: JSON.stringify({ income_verification: { status: "VERIFIED" } }) }
          : {}),
      };
      documents = [...documents, document];
      return { data: {
        document,
        documentValidation: documentValidation(body.get("documentType")),
      } };
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("progressbar", { name: "Document upload progress" })).toHaveAttribute("aria-valuenow", "0");
    const checklist = within(screen.getByLabelText("Required document progress"));
    expect(checklist.getByText("ID proof")).toBeInTheDocument();
    expect(checklist.queryByText("PAN card")).not.toBeInTheDocument();
    expect(checklist.getByText("Payslips")).toBeInTheDocument();
    expect(checklist.getByText("Bank statements")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review financial profile/ })).not.toBeInTheDocument();

    const uploads = [
      ["sample_id_proof_check2.pdf", 33],
      ["three-months-payslips.pdf", 67],
      ["three-months-bank-statement.pdf", 100],
    ];
    for (const [filename, percentage] of uploads) {
      fireEvent.change(screen.getByLabelText("Select documents"), {
        target: { files: [new File(["document"], filename, { type: "application/pdf" })] },
      });
      fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));
      await waitFor(() => expect(screen.getByRole("progressbar", { name: "Document upload progress" })).toHaveAttribute("aria-valuenow", String(percentage)));
      if (percentage === 33) expect(screen.getByRole("heading", { name: "Payslips" })).toBeInTheDocument();
    }

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/applications/app-1/extract", {}, expect.anything()));
    expect(api.post).toHaveBeenCalledTimes(4);
    expect(await screen.findByRole("heading", { name: "Checking your documents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Extract Documents" })).not.toBeInTheDocument();
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/documents")).map(([, body]) => body.get("documentType")))
      .toEqual(["aadhaar", "payslips", "bank-statements"]);
  });

  it("records a manual-review REFER when document verification fails", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [{ id: "aadhaar", originalName: "aadhaar.pdf", status: "NEEDS_REVIEW" }],
      workflow: {
        ready: false,
        processing: false,
        unextracted: [],
        missing: ["payslips", "bank-statements"],
        failures: [{ documentType: "aadhaar", field: "applicant_name", reason: "Applicant name does not match." }],
        documents: [],
      },
      decisions: [],
    } });
    api.post.mockResolvedValue({ data: { outcome: "REFER", rulesTriggered: ["MANUAL_REVIEW_REQUIRED"] } });
    renderPage("/applications/app-1/profile", "/applications/:applicationId/profile", <ExtractedProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Request manual review" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/ai/run", {
      applicationId: "app-1",
      mode: "MANUAL_REVIEW",
    }, expect.anything()));
    expect(await screen.findByText("Decision explanation")).toBeInTheDocument();
  });

  it("removes an uploaded document and returns its checklist step", async () => {
    let documents = [{ id: "document-aadhaar", originalName: "aadhaar-card.pdf", mimeType: "application/pdf", sizeBytes: 1200, status: "PROCESSED" }];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    api.delete.mockImplementation(async () => {
      documents = [];
      return { data: { id: "document-aadhaar", deleted: true } };
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("progressbar", { name: "Document upload progress" })).toHaveAttribute("aria-valuenow", "33");
    fireEvent.click(screen.getByRole("button", { name: "Remove aadhaar-card.pdf" }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Document upload progress" })).toHaveAttribute("aria-valuenow", "0"));
    expect(screen.getByRole("heading", { name: "ID proof" })).toBeInTheDocument();
    expect(api.delete).toHaveBeenCalledWith("/documents/document-aadhaar");
  });

  it("shows extraction processing per document until the AI workflow finishes", async () => {
    let documents = [{ id: "document-1", originalName: "payslips.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "PROCESSING" }];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByText("Extraction processing")).toBeInTheDocument();
    documents = [{ ...documents[0], status: "PROCESSED" }];
    await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument(), { timeout: 4000 });
  });

  it("clearly rejects a file classified as a non-bank document", async () => {
    const bank = {
      id: "bank",
      originalName: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1200,
      status: "NEEDS_REVIEW",
      extractionError: "This file does not appear to be a bank statement. Remove it and upload the correct document.",
      extractedValues: JSON.stringify({
        document_type: "bank-statements",
        document_verification: { field: "income_document_type", status: "FAILED" },
      }),
    };
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [
        { id: "aadhaar", originalName: "aadhaar.pdf", status: "UPLOADED" },
        { id: "payslip", originalName: "payslip.pdf", status: "UPLOADED" },
        bank,
      ],
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByText("Wrong document type", { selector: ".required-document-status" })).toBeInTheDocument();
    expect(screen.getByText(bank.extractionError)).toBeInTheDocument();
    expect(screen.queryByText("OK · Uploaded")).not.toBeInTheDocument();
  });

  it("after extraction, reports failed verification and routes to the extracted profile", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [
        { id: "aadhaar", originalName: "aadhaar.pdf", status: "NEEDS_REVIEW" },
        { id: "payslip", originalName: "payslip-month-3.pdf", status: "PROCESSED" },
        { id: "bank", originalName: "bank-statement-month-3.pdf", status: "NEEDS_REVIEW" },
      ],
      workflow: { ready: false, reason: "Account holder name could not be verified." },
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("heading", { name: "Some uploaded documents are not correct" })).toBeInTheDocument();
    expect(screen.getByText(/Please check the documents below/)).toBeInTheDocument();
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Continue to next step/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review details" }));
    expect(await screen.findByText("Profile results")).toBeInTheDocument();
  });

  it("routes verified documents to the extracted profile before eligibility", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [
        { id: "aadhaar", originalName: "aadhaar.pdf", status: "PROCESSED" },
        { id: "payslip", originalName: "payslip-month-3.pdf", status: "PROCESSED" },
        { id: "bank", originalName: "bank-statement-month-3.pdf", status: "PROCESSED" },
      ],
      workflow: { ready: true },
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("heading", { name: "All documents verified" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue to next step/ }));
    expect(await screen.findByText("Profile results")).toBeInTheDocument();
  });

  it("offers eligibility only after the backend confirms every verification is complete", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [],
      income: { monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000 },
      workflow: {
        ready: true,
        documents: [],
        verifiedFinancials: {
          monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000, salaryCredit: 4000,
          evidence: { netSalary: { quote: "Net Salary: 4,000", documentName: "payslip.pdf" }, monthlyObligations: [] },
        },
      },
    } });
    renderPage("/applications/app-1/profile", "/applications/:applicationId/profile", <ExtractedProfilePage />);

    expect(await screen.findByText("“Net Salary: 4,000” — payslip.pdf")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Proceed to Eligibility/ }));
    expect(await screen.findByText("Eligibility page")).toBeInTheDocument();
  });

  it("runs deterministic eligibility on the verified figures", async () => {
    api.get.mockImplementation(async (url) => url.endsWith("/eligibilityrules")
      ? { data: { items: [{ active: true, version: "DEMO-1", config: { eligibleBelowDti: 35, notEligibleAboveDti: 50 } }] } }
      : { data: {
        id: "app-1",
        applicationNo: "BNK-123",
        loanAmount: 12000,
        loanTermMonths: 36,
        applicantProvidedFinancials: { monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000 },
        workflow: { ready: true, verifiedFinancials: { monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000 } },
      } });
    api.post.mockResolvedValue({ data: { outcome: "ELIGIBLE", rulesTriggered: [], rulebookVersion: "DEMO-1" } });
    renderPage("/applications/app-1/eligibility", "/applications/:applicationId/eligibility", <EligibilityPage />);

    expect(await screen.findByText("Monthly net income (used for DTI)")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Run Eligibility" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/ai/run", {
      applicationId: "app-1",
      mode: "ELIGIBILITY",
    }, expect.anything()));
    expect(await screen.findByText("Decision explanation")).toBeInTheDocument();
  });

  it("does not offer eligibility until the documents are verified", async () => {
    api.get.mockImplementation(async (url) => url.endsWith("/eligibilityrules")
      ? { data: { items: [{ active: true, version: "DEMO-1", config: { eligibleBelowDti: 35, notEligibleAboveDti: 50 } }] } }
      : { data: {
        id: "app-1",
        applicationNo: "BNK-123",
        loanAmount: 12000,
        loanTermMonths: 36,
        applicantProvidedFinancials: { monthlyGross: 5000, monthlyNet: 4000, monthlyObligations: 1000 },
        workflow: { ready: false, reason: "Documents require review." },
      } });
    api.post.mockResolvedValue({ data: { outcome: "ELIGIBLE", rulesTriggered: ["DEMO_DTI_WITHIN_ELIGIBLE_THRESHOLD"], rulebookVersion: "DEMO-1" } });
    renderPage("/applications/app-1/eligibility", "/applications/:applicationId/eligibility", <EligibilityPage />);

    expect(await screen.findByRole("heading", { name: "Eligibility cannot run yet" })).toBeInTheDocument();
    expect(screen.getByText("Documents require review.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Eligibility" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review extracted profile/ })).toHaveAttribute("href", "/applications/app-1/profile");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("continues the upload flow after an extracted document is submitted", async () => {
    const documents = [
      { id: "document-1", originalName: "three-months-payslips.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "NEEDS_REVIEW" },
      { id: "document-2", originalName: "three-months-bank-statement.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "PROCESSED", extractedValues: JSON.stringify({ income_verification: { status: "NEEDS_REVIEW" } }) },
      { id: "document-3", originalName: "aadhaar-card.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "UPLOADED" },
    ];
    api.get.mockResolvedValue({ data: { id: "app-1", applicationNo: "BNK-123", documents } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />, { allowDocumentCorrection: true });

    expect(await screen.findByRole("button", { name: "Extract Documents" })).toBeInTheDocument();
    expect(screen.getByText("Needs review", { selector: ".required-document-status" })).toBeInTheDocument();
    expect(screen.queryByText("Decision explanation")).not.toBeInTheDocument();
  });

  it("does not create or route to a manual decision before the applicant requests it", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [
        { id: "id-proof", originalName: "sample_id_proof_check2.pdf", status: "UPLOADED" },
        { id: "payslip", originalName: "sample_payslips_check2_aug_oct_2026.pdf", status: "NEEDS_REVIEW" },
        { id: "bank", originalName: "sample_bank_statement_check2_aug_oct_2026.pdf", status: "PROCESSED" },
      ],
      decisions: [],
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("button", { name: "Extract Documents" })).toBeInTheDocument();
    expect(screen.queryByText("Decision explanation")).not.toBeInTheDocument();
  });

  it("does not classify untyped uploads as required documents", async () => {
    api.get.mockResolvedValue({ data: {
      id: "app-1",
      applicationNo: "BNK-123",
      documents: [
        { id: "guide", originalName: "BABOK_Guide_v3_Member.pdf", status: "NEEDS_REVIEW", extractionError: "Source evidence could not be verified." },
        { id: "high-fidelity", originalName: "Hi-fidelity.pdf", status: "NEEDS_REVIEW" },
        { id: "low-fidelity", originalName: "Lo-fidelity.pdf", status: "NEEDS_REVIEW" },
      ],
      decisions: [],
    } });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    expect(await screen.findByRole("heading", { name: "Supporting documents" })).toBeInTheDocument();
    expect(screen.queryByText("Decision explanation")).not.toBeInTheDocument();
  });

  it("stays on the upload page while another document is still extracting", async () => {
    let documents = [
      { id: "document-1", originalName: "three-months-payslips.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "NEEDS_REVIEW" },
      { id: "document-2", originalName: "three-months-bank-statement.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "PROCESSING" },
      { id: "document-3", originalName: "aadhaar-card.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "UPLOADED" },
    ];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />);

    await screen.findByRole("progressbar", { name: "Document upload progress" });
    await waitFor(() => expect(screen.getAllByText(/Extraction processing/).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(screen.queryByText("Decision explanation")).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Extract Documents" })).not.toBeInTheDocument();
    expect(screen.queryByText("Decision explanation")).not.toBeInTheDocument();
  });

  it("keeps every selected PDF and advances progress after the batch uploads", async () => {
    let documents = [];
    api.get.mockImplementation(async () => ({
      data: { id: "app-1", applicationNo: "BNK-123", documents },
    }));
    api.post.mockImplementation(async (_url, body) => {
      const file = body.get("file");
      const document = {
        id: `document-${documents.length + 1}`,
        originalName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "UPLOADED",
        extractedValues: JSON.stringify({ document_type: body.get("documentType") }),
      };
      documents = [...documents, document];
      return { data: {
        document: { ...document, extractedValues: JSON.stringify({ upload_validation: documentValidation("aadhaar") }) },
        documentValidation: documentValidation("aadhaar"),
        error: { message: "Financial data could not be verified." },
      } };
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />, { allowDocumentCorrection: true });

    const picker = await screen.findByLabelText("Select documents");
    fireEvent.change(picker, {
      target: { files: [new File(["page one"], "aadhaar-page-1.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(picker, {
      target: { files: [new File(["page two"], "aadhaar-page-2.pdf", { type: "application/pdf" })] },
    });
    expect(screen.getByText("aadhaar-page-1.pdf")).toBeInTheDocument();
    expect(screen.getByText("aadhaar-page-2.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload 2 documents" }));

    await waitFor(() => {
      const progress = screen.getByRole("progressbar", { name: "Document upload progress" });
      expect(progress).toHaveAttribute("aria-valuenow", "33");
      expect(progress.querySelector("span")).toHaveStyle({ width: "33%" });
    });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("aadhaar-page-1.pdf")).toHaveLength(1);
    expect(screen.getAllByText("aadhaar-page-2.pdf")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Payslips" })).toBeInTheDocument();
  });

  it("allows a corrected upload to replace the latest failed attempt without deleting history", async () => {
    let documents = [
      { id: "old-pay", originalName: "salary-slip.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "NEEDS_REVIEW" },
      { id: "bank", originalName: "bank-statement.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "PROCESSED", extractedValues: JSON.stringify({ income_verification: { status: "NEEDS_REVIEW" } }) },
      { id: "aadhaar", originalName: "aadhaar-card.pdf", mimeType: "application/pdf", sizeBytes: 1000, status: "UPLOADED" },
    ];
    api.get.mockImplementation(async () => ({ data: { id: "app-1", applicationNo: "BNK-123", documents } }));
    api.post.mockImplementation(async (_url, body) => {
      const document = {
        id: "corrected-pay",
        originalName: body.get("file").name,
        mimeType: "application/pdf",
        sizeBytes: 1000,
        status: "UPLOADED",
        extractedValues: JSON.stringify({ document_type: body.get("documentType") }),
      };
      documents = [...documents, document];
      return { data: {
        document: { ...document, extractedValues: JSON.stringify({ upload_validation: documentValidation("payslips") }) },
        documentValidation: documentValidation("payslips"),
      } };
    });
    renderPage("/applications/app-1/documents", "/applications/:applicationId/documents", <DocumentUploadPage />, { allowDocumentCorrection: true });

    fireEvent.click(await screen.findByRole("button", { name: "Replace Payslips" }));
    fireEvent.change(await screen.findByLabelText("Select documents"), {
      target: { files: [new File(["corrected"], "new-salary-slip.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Upload document/ }));

    expect(await screen.findByRole("button", { name: "Extract Documents" })).toBeInTheDocument();
    expect(screen.getAllByText("salary-slip.pdf")).toHaveLength(1);
    expect(screen.getAllByText("new-salary-slip.pdf")).toHaveLength(2);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("renders a deterministic decision and the loading error state", async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/decision")
      ? { outcome: "REFER", dtiPercent: 31, rulesTriggered: ["MANUAL_REVIEW_REQUIRED"], rulebookVersion: "DEMO-1", explanation: "Manual review is required." }
      : { applicationNo: "BNK-123", income: { monthlyNet: 4000, monthlyObligations: 1000 } } }));
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "REFER – MANUAL REVIEW REQUIRED" })).toBeInTheDocument());
    expect(screen.getByText("31%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Correct and re-upload documents" })).toHaveAttribute("href", "/applications/app-1/documents");
    expect(screen.getAllByText("Not verified")).toHaveLength(2);

    api.get.mockRejectedValueOnce({ response: { data: { message: "Backend unavailable" } } });
    renderPage("/", "/", <DashboardPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable"));
  });

  it("shows the verified figures, their sources and the explanation", async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/decision")
      ? {
        outcome: "ELIGIBLE", dtiPercent: 27.27, rulesTriggered: ["DEMO_DTI_WITHIN_ELIGIBLE_THRESHOLD"], rulebookVersion: "DEMO-1",
        createdAt: "2026-11-04T10:00:00Z",
        explanation: "Your application is eligible under rulebook DEMO-1.\nRules applied: a DTI below 35% is eligible (DEMO_DTI_WITHIN_ELIGIBLE_THRESHOLD).",
        financialSnapshot: {
          financialInputSource: "VERIFIED_DOCUMENTS", verifiedFinancialInputs: true, explanationSource: "template",
          monthlyNet: 55000, monthlyObligations: 15000, loanAmount: 500000,
          netIncomeSource: "payslip net salary, matched to the salary credit on the bank statement",
          obligationsSource: "stated on the payslip",
          evidence: {
            netSalary: { quote: "Net salary: INR 55,000.00", documentName: "payslip-month-3.pdf" },
            salaryCredit: { quote: "28 Oct 2026 Salary credited 55,000.00", documentName: "bank-statement-month-3.pdf" },
            monthlyObligations: [{ source: "payslip", quote: "Existing monthly loan obligations: INR 15,000.00", documentName: "payslip-month-3.pdf" }],
          },
        },
      }
      : { applicationNo: "BNK-123", status: "ELIGIBLE", reviews: [] } }));
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);

    expect(await screen.findByRole("heading", { name: "Eligible under demo rules" })).toBeInTheDocument();
    expect(screen.getByText(/Your application is eligible under rulebook DEMO-1\./)).toBeInTheDocument();
    expect(screen.getByText("27.27%")).toBeInTheDocument();
    expect(screen.getByText("“Net salary: INR 55,000.00” — payslip-month-3.pdf")).toBeInTheDocument();
    expect(screen.getByText("“Existing monthly loan obligations: INR 15,000.00” — payslip-month-3.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Correct and re-upload documents" })).not.toBeInTheDocument();
  });

  it("shows a clear error when no saved decision exists", async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith("/decision")) return Promise.reject({ response: { status: 404, data: { message: "No eligibility decision is available yet" } } });
      return Promise.resolve({ data: {
        applicationNo: "BNK-123",
        documents: [
          { id: "guide", originalName: "BABOK_Guide_v3_Member.pdf", status: "NEEDS_REVIEW", extractionError: "Source evidence could not be verified." },
          { id: "high-fidelity", originalName: "Hi-fidelity.pdf", status: "NEEDS_REVIEW" },
          { id: "low-fidelity", originalName: "Lo-fidelity.pdf", status: "NEEDS_REVIEW" },
        ],
      } });
    });
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No eligibility decision is available yet");
    expect(screen.queryByRole("link", { name: "Correct and re-upload documents" })).not.toBeInTheDocument();
  });

  it("shows the final loan officer decision alongside the automated result", async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/decision")
      ? { outcome: "REFER", dtiPercent: null, rulesTriggered: ["MANUAL_REVIEW_REQUIRED"], rulebookVersion: "DEMO-1", explanation: "Manual review is required." }
      : {
        applicationNo: "BNK-123",
        status: "APPROVED",
        income: { monthlyNet: 4000, monthlyObligations: 1000 },
        reviews: [{ outcome: "APPROVED", remarks: "Approved after manual review.", score: 100, createdAt: "2026-10-03T10:00:00Z" }],
      } }));
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);

    expect(await screen.findByRole("heading", { name: "Approved by loan officer" })).toBeInTheDocument();
    expect(screen.getByText("Approved after manual review.")).toBeInTheDocument();
    expect(screen.getByText("APPROVED", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("100 / 100")).toBeInTheDocument();
    expect(screen.queryByText("REFER")).not.toBeInTheDocument();
    expect(screen.queryByText("AUTOMATED ELIGIBILITY RESULT")).not.toBeInTheDocument();
  });

  it("uses the current eligible application status instead of a stale referred decision", async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/decision")
      ? { outcome: "REFER", dtiPercent: 30, rulesTriggered: ["BORDERLINE_DTI"], rulebookVersion: "DEMO-1", explanation: "Manual review is required." }
      : { applicationNo: "BNK-123", status: "ELIGIBLE", income: { monthlyNet: 4000, monthlyObligations: 1200 }, reviews: [] } }));
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);

    expect(await screen.findByRole("heading", { name: "Eligible under demo rules" })).toBeInTheDocument();
    expect(screen.getByText("ELIGIBLE", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("Current application status: ELIGIBLE.")).toBeInTheDocument();
    expect(screen.queryByText("REFER")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual review is required.")).not.toBeInTheDocument();
  });

  it("shows only the final declined result after an officer rejects a referral", async () => {
    api.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/decision")
      ? { outcome: "REFER", dtiPercent: 42, rulesTriggered: ["MANUAL_REVIEW_REQUIRED"], rulebookVersion: "DEMO-1", explanation: "Manual review is required." }
      : {
        applicationNo: "BNK-123",
        status: "DECLINED",
        reviews: [{ outcome: "DECLINED", remarks: "Application declined after review.", createdAt: "2026-10-03T10:00:00Z" }],
      } }));
    renderPage("/applications/app-1/decision", "/applications/:applicationId/decision", <DecisionPage />);

    expect(await screen.findByRole("heading", { name: "Declined by loan officer" })).toBeInTheDocument();
    expect(screen.getByText("DECLINED", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("Application declined after review.")).toBeInTheDocument();
    expect(screen.queryByText("REFER")).not.toBeInTheDocument();
    expect(screen.queryByText("AUTOMATED ELIGIBILITY RESULT")).not.toBeInTheDocument();
  });

  it("renders a readable audit history with every decision and chronological events", async () => {
    const events = [
      { id: "event-later", action: "ELIGIBILITY_CALCULATED", actorId: "officer-1", createdAt: "2026-10-03T12:00:00Z", details: JSON.stringify({ outcome: "REFER", rulebookVersion: "DEMO-2" }) },
      { id: "event-earlier", action: "DOCUMENT_UPLOADED", actorId: "customer-1", createdAt: "2026-10-01T10:00:00Z", details: JSON.stringify({ documentId: "document-1", status: "PROCESSED" }) },
    ];
    api.get.mockImplementation(async (url) => {
      if (url.endsWith("/audit")) return { data: {
        applicationId: "app-audit",
        applicationNo: "BNK-AUDIT",
        financialProfile: {
          monthlyGross: 6000,
          monthlyNet: 5000,
          monthlyObligations: 1000,
          employment: "Salaried",
          incomeSource: "Employment",
          originalValues: { monthly_gross: 6000, monthly_net: 5000, monthly_obligations: 1200, employment: "Salaried", income_source: "Employment" },
          correctedValues: { monthly_gross: 6000, monthly_net: 5000, monthly_obligations: 1000, employment: "Salaried", income_source: "Employment" },
          evidence: {},
        },
        decisions: [
          { id: "decision-refer", outcome: "REFER", dtiPercent: 24, rulesTriggered: ["MANUAL_REVIEW_REQUIRED"], rulebookVersion: "DEMO-1", explanation: "Manual review was required.", createdAt: "2026-10-02T10:00:00Z" },
          { id: "decision-approved", outcome: "ELIGIBLE", dtiPercent: 20, rulesTriggered: ["DTI_WITHIN_LIMIT"], rulebookVersion: "DEMO-2", explanation: "The application met the eligibility rules.", createdAt: "2026-10-03T10:00:00Z" },
        ],
        reviews: [],
        items: events,
        total: events.length,
      } };
      return { data: {
        id: "app-audit",
        applicationNo: "BNK-AUDIT",
        applicant: { fullName: "Riya Sample" },
        status: "ELIGIBLE",
        loanAmount: 12000,
        documents: [{ id: "document-1", originalName: "payslip.pdf", mimeType: "application/pdf", sizeBytes: 1200 }],
      } };
    });
    const { container } = renderPage("/applications/app-audit/audit", "/applications/:applicationId/audit", <AuditPage />);

    expect(await screen.findByRole("heading", { name: "Application audit history" })).toBeInTheDocument();
    const applicationSummary = container.querySelector(".audit-application-summary");
    expect(within(applicationSummary).getByText("Applicant name")).toBeInTheDocument();
    expect(within(applicationSummary).getByText("Riya Sample")).toBeInTheDocument();
    expect(within(applicationSummary).queryByText("Application ID")).not.toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    expect(screen.getByText("No additional evidence recorded.")).toBeInTheDocument();
    expect(screen.getAllByText(/₹5,000(?:\.00)?/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Monthly obligations").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/₹1,200(?:\.00)?/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/₹1,000(?:\.00)?/).length).toBeGreaterThan(0);

    const decisionCards = container.querySelectorAll(".audit-decision-card");
    expect(decisionCards).toHaveLength(2);
    expect(within(decisionCards[0]).getByText("DEMO-1")).toBeInTheDocument();
    expect(within(decisionCards[1]).getByText("DEMO-2")).toBeInTheDocument();
    expect(screen.getByText("Manual review was required.")).toBeInTheDocument();
    expect(screen.getByText("The application met the eligibility rules.")).toBeInTheDocument();

    const timelineHeadings = [...container.querySelectorAll(".audit-event-heading h3")].map((heading) => heading.textContent);
    expect(timelineHeadings).toEqual(["Document Uploaded", "Eligibility Calculated"]);
    expect(screen.getByText("payslip.pdf")).toBeInTheDocument();
    expect(container.querySelector(".audit-technical-details")).not.toHaveAttribute("open");
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("submits and saves the officer's numeric score with the review", async () => {
    api.get.mockResolvedValue({ data: {
      total: 1,
      items: [{
        id: "app-review",
        applicationNo: "BNK-REVIEW",
        applicant: { fullName: "Referral Applicant" },
        loanAmount: 8000,
        decisions: [{ dtiPercent: 40, explanation: "Manual review required." }],
      }],
    } });
    api.post.mockResolvedValue({ data: { id: "review-1", outcome: "APPROVED", remarks: "Approved.", score: 100 } });
    renderPage("/referrals", "/referrals", <ReferralsPage />);
    fireEvent.change(await screen.findByLabelText("Review outcome"), { target: { value: "APPROVED" } });
    fireEvent.change(screen.getByPlaceholderText("Review remarks"), { target: { value: "Approved." } });
    fireEvent.change(screen.getByLabelText("Officer score (0-100)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Record review" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/referrals/app-review/review",
      { outcome: "APPROVED", remarks: "Approved.", score: 100 },
      expect.objectContaining({ headers: { "Idempotency-Key": expect.any(String) } }),
    ));
  });

  it("searches and filters the API-backed application list", async () => {
    api.get.mockResolvedValueOnce({ data: {
      total: 2,
      items: [
        { id: "app-1", applicationNo: "BNK-101", applicant: { fullName: "Asha Patel" }, loanAmount: 12000, loanTermMonths: 36, status: "ELIGIBLE", createdAt: "2026-10-01T10:00:00Z" },
        { id: "app-2", applicationNo: "BNK-102", applicant: { fullName: "Ravi Kumar" }, loanAmount: 8000, loanTermMonths: 24, status: "REFER", createdAt: "2026-10-02T10:00:00Z" },
      ],
    } });
    renderPage("/applications", "/applications", <ApplicationsPage />);
    expect(await screen.findByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "ravi" } });
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    expect(screen.queryByText("Asha Patel")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), { target: { value: "ELIGIBLE" } });
    expect(screen.getByText("No applications match these filters.")).toBeInTheDocument();
  });

  it("refreshes the customer application status after an officer decision", async () => {
    let updated = false;
    api.get.mockImplementation(async () => ({
      data: {
        total: 1,
        items: [{
          id: "app-review",
          applicationNo: "BNK-REVIEW",
          applicant: { fullName: "Referral Applicant" },
          loanAmount: 8000,
          loanTermMonths: 24,
          status: updated ? "APPROVED" : "REFER",
          createdAt: "2026-10-01T10:00:00Z",
        }],
      },
    }));
    renderPage("/applications", "/applications", <ApplicationsPage />);

    const applicationRow = await screen.findByRole("row", { name: /BNK-REVIEW/ });
    expect(within(applicationRow).getByText("REFER")).toBeInTheDocument();
    updated = true;
    await waitFor(() => expect(within(applicationRow).getByText("APPROVED")).toBeInTheDocument(), { timeout: 5000 });
    expect(within(applicationRow).queryByText("REFER")).not.toBeInTheDocument();
  });

  it("removes the selected loan application after confirmation", async () => {
    let items = [{
      id: "app-remove",
      applicationNo: "LOAN-REMOVE",
      applicant: { fullName: "Remove Me" },
      loanAmount: 12000,
      loanTermMonths: 36,
      status: "PENDING",
      createdAt: "2026-10-01T10:00:00Z",
    }];
    api.get.mockImplementation(async () => ({ data: {
      total: 1,
      items,
    } }));
    api.delete.mockImplementation(async () => {
      items = [];
      return { data: { id: "app-remove", deleted: true } };
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderPage("/applications", "/applications", <ApplicationsPage />);

    expect(await screen.findByText("Remove Me")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove application LOAN-REMOVE" }));

    await waitFor(() => expect(screen.getByText("No applications yet.")).toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith("/applications/app-remove");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("LOAN-REMOVE"));
  });
});
