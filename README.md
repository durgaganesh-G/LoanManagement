# Loan Origination & Eligibility Assistant

A student-capstone implementation with a React client, Express/Prisma API, PostgreSQL storage, and a Python AI service. pgAdmin can be used to manage the PostgreSQL database. Lending results are determined only by a versioned deterministic rulebook; DTI uses verified net income per the BRD worked example. The AI service is limited to evidenced extraction and explanation text.

## How a decision is made

1. **Upload** — the ID proof, payslip and bank statement are uploaded as PDFs. A local, deterministic check reads each PDF's actual content (its text, or Docling OCR for scanned and photo-only PDFs) and accepts only: an ID proof that shows the holder's name, a payslip that shows the employee name and a salary amount, and a bank statement that shows the account holder's name. Anything else (a photo, a resume, a random PDF, or a document in the wrong slot) is rejected with the reason and is not saved. The extension, MIME type and filename are never trusted on their own. If `OLLAMA_VISION_MODEL` names a locally installed vision model, scanned or photo-only PDFs are also shown to it; it can only reject, never accept. When all three documents are in, the extraction and verification below start automatically.
2. **Extract** — the local LLM (Ollama) extracts names, gross and net salary, stated monthly obligations and bank transactions. Every value is verified against the exact labelled line in the document; values that cannot be verified are left empty, never guessed.
3. **Verify** — names must match the application across all three documents, and the payslip net salary must match the salary credited on the bank statement. The verified figures and their source lines are shown on the **Extracted profile** page.
4. **Decide** — the deterministic rulebook calculates DTI = monthly obligations ÷ verified net income × 100 (`DEMO-1`: below 35% eligible, above 40% not eligible, in between referred). The figures typed on the application are only a cross-check; a mismatch is referred to a loan officer.
5. **Explain** — the decision page explains the outcome in plain language, citing the figures, their sources, the DTI calculation, every rule that fired and the rulebook version.
6. **Refer and audit** — documents that fail verification, borderline DTIs and stated-income mismatches go to the officer referral queue; every decision is stored with its figures, evidence and rules.

## Requirements

- Node.js 20+
- Python 3.11–3.13 (check package support before using newer Python versions)
- npm
- Ollama and a locally installed model are optional; without one, extraction returns an explicit unavailable/needs-review result and explanations use a deterministic template.

## Run locally

1. In pgAdmin, connect to your local PostgreSQL server and create an empty database named `loan_management`.
2. Copy `backend/.env.example` to `backend/.env`. Replace `YOUR_PASSWORD` in `DATABASE_URL` with your local PostgreSQL password; URL-encode special characters in the password. Keep this value local and do not commit or share it. The default host and port are `localhost:5432`.
3. Copy `frontend/.env.example` to `frontend/.env`.
4. From `backend/`, run `npm install`, `npm run db:generate`, `npm run db:migrate`, `npm run db:seed`, then `npm run dev`.
5. From `aiservices/`, create a Python 3.12 virtual environment, install `requirements.txt`, copy `.env.example` to `.env`, then run `uvicorn app.main:app --reload --port 8000`.
6. From `frontend/`, run `npm install` and `npm run dev`.
7. Open the Vite URL (normally `http://localhost:5173`). Seeded local accounts (all use `DemoPass123!` by default) are `officer@bnk.local` (officer), `auditor@bnk.local` (read-only audit), `asha.applicant@demo.local`, and `ravi.applicant@demo.local`. Override each role's seed password with its `DEMO_*_PASSWORD` environment variable.

The application starts with an empty PostgreSQL database and synthetic seed data; existing SQLite records are not copied.

PowerShell setup commands:

```powershell
# Terminal 1: start Ollama only if it is not already running as a service
ollama serve

# Terminal 2: download the configured local model
ollama pull llama3.2

Set-Location .\backend
# Create the loan_management database in pgAdmin, then copy and edit the connection URL in .env.
Copy-Item .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev

# In a second terminal
Set-Location .\aiservices
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000

# In a separate terminal, from aiservices/
python -m pytest -q
python -m app.evaluation

# In a third terminal
Set-Location .\frontend
Copy-Item .env.example .env
npm install
npm run dev
```

The Node service listens on port 4000 by default and the AI service on port 8000. Start the AI service from this project's `aiservices/` folder; the backend calls its routes at the root (for example `http://127.0.0.1:8000/documents/validate`), and they are also available under `/api`. If a different or older AI service is running on that port, `/api/health` reports the AI dependency as unavailable and uploads fail with "the AI service ... does not provide document checks" — nothing is saved unchecked. The first scanned or photo-only PDF after the AI service starts can take up to about two minutes while the OCR models load; later ones are much faster. Configure service URLs and secrets in each service's `.env`; do not commit real credentials. No paid or hosted AI service is used. Only `.pdf` files with PDF content are currently accepted; image uploads remain unsupported. Before saving each PDF, the backend asks the AI service's local upload check (`POST /documents/validate`) whether it is an ID proof, payslip, or bank statement that matches its upload slot. Any other PDF is rejected without a database record, and if the check cannot run the upload fails closed (`503`). The backend waits up to `DOCUMENT_VALIDATION_TIMEOUT_MS` (default 180 seconds) so scanned PDFs have time for OCR. Accepted files are staged as `UPLOADED`; the user then starts the existing extraction workflow, which continues to use Docling and Ollama. Text PDFs use a fast text extraction path, while scanned PDFs use Docling OCR. The backend AI workflow timeout defaults to 300 seconds to allow for configured Ollama retries. Uploaded files are stored under `backend/uploads/`. PostgreSQL migrations are under `backend/prisma/postgres/migrations/`; the legacy SQLite database and migrations remain in their original locations but are not used by the application. The backend seed creates ten synthetic applications across eligible, referred, and not-eligible outcomes, with synthetic document text and source evidence. Seed document fixtures are text files for demo viewing/download only; application uploads accept PDF only.

The upload check is deterministic and runs locally: it reads the PDF's text (Docling OCR for scanned PDFs) and classifies it from the document's structure, never from the filename, and never with the LLM. An ID proof needs an identity heading (for example Aadhaar, PAN card, passport, or voter ID), the holder's name, and at least one more identity detail with a real value (date of birth, gender, address, or ID number); a sheet that only lists "Not provided" values is rejected. A payslip needs a payslip/salary-slip heading with payroll details; a bank statement needs a bank/account statement heading with account details or dated transactions. A document uploaded to the wrong slot is rejected with a message naming the slot it belongs in. The check only accepts or rejects the document; it does not extract financial values or make lending decisions. The same file-content checks remain in the existing workflow before Ollama extraction: an ID proof needs identity-specific details and a labeled name; a payslip needs payroll structure plus employee name, gross salary, and net salary; a bank statement needs account details, a labeled account holder, and at least two dated transaction rows with debit/credit indicators. Incomplete or unreadable documents are routed to manual review. OCR success alone is not document validation.

After the content gate, ID-proof uploads extract the explicitly labeled `applicant_name`; payslips extract only the explicitly stated `employee_name`, `gross_income`, and `net_salary`; bank statements extract `account_holder_name` and up to five recent transactions (`date`, `description`, `amount`, `type`, and exact source `evidence`). Each extracted value is checked against source evidence. Names are compared across individually verified documents before application readiness is granted. Missing values remain null, and unverified or inconsistent values are sent for review. These document fields do not independently establish a lending decision: the deterministic eligibility engine uses the application's verified financial inputs and rulebook. Content checks cannot prove document authenticity or reliably distinguish a genuine document from a visually convincing forgery; officer review remains necessary when content is uncertain.

## Development and validation

- Backend: `npm test`, `npm run db:migrate`, `npm run db:seed`
- Frontend: `npm test`, `npm run build`
- AI: `python -m pytest tests ../tests/ai ../tests/integration` (from `aiservices/`)
- AI evaluation: `python -m app.evaluation` from `aiservices/`; results are written to `aiservices/evals/evaluation_results.json`. Deterministic evaluation requires 100% on decisions, explanations, and safety fixtures. If Ollama and the configured model are running, extraction field accuracy must be at least 90% and the 12 prompt-injection checks must all preserve grounded values. Add `--require-llm` to fail when those model scores cannot be measured.

The evaluation runner reports measured results on the provided fixture set; fixture results are not a claim about real lending performance. Without Ollama, the evaluation status is `PARTIAL` and extraction accuracy is reported as `NOT_RUN`, not passed. See [docs/PRD.md](docs/PRD.md), [docs/DATA_MODEL.md](docs/DATA_MODEL.md), [docs/API_CONTRACT.md](docs/API_CONTRACT.md), [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md), [docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md), and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Data and policy note

This is a demo application, not a lending product. The included rulebook is explicitly a configurable demo rulebook and contains no purported bank policy. Confirm applicable policies, privacy controls, and regulatory requirements before any real use.
