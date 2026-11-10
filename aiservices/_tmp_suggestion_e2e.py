import base64
import fitz

from app.graph.workflow import run_workflow

ROWS = [
    ("2026-08-01", "Opening balance", "-", "-"),
    ("2026-08-05", "Salary credit - Sample Employer", "-", "10,000.00"),
    ("2026-08-10", "Existing loan EMI (illustrative)", "8,000.00", "-"),
    ("2026-09-05", "Salary credit - Sample Employer", "-", "10,000.00"),
    ("2026-09-10", "Existing loan EMI (illustrative)", "8,000.00", "-"),
    ("2026-10-05", "Salary credit - Sample Employer", "-", "10,000.00"),
    ("2026-10-10", "Existing loan EMI (illustrative)", "8,000.00", "-"),
]
LINES = [
    "SAMPLE BANK STATEMENT",
    "Three-month synthetic transaction history - August-October 2026",
    "DEMO ONLY: This is not issued by a bank, is not a real account statement and must not be used for financial verification.",
    "Account field",
    "Value",
    "Account holder",
    "check2",
    "Bank",
    "Demo Bank (fictional)",
    "Account number",
    "XXXX-XXXX-0000 (placeholder)",
    "Currency",
    "USD ($)",
    "Period",
    "01 Aug 2026 - 31 Oct 2026",
    "Opening balance",
    "$10,000.00",
    "Transaction history",
    "Date",
    "Description",
    "Debit ($)",
    "Credit ($)",
]
LINES += [cell for row in ROWS for cell in row]
LINES += [
    "Statement summary",
    "Summary item",
    "Amount",
    "Total salary credits (3 months)",
    "$30,000.00",
    "Total illustrative EMI debits (3 months)",
    "$24,000.00",
    "Closing balance",
    "$16,000.00",
]

path = r"C:\Users\DurgaGaneshGorrela\AppData\Local\Temp\opencode\high_dti_statement.pdf"
doc = fitz.open()
page = doc.new_page()
y = 60
for line in LINES:
    page.insert_text((50, y), line, fontsize=9, fontname="helv")
    y += 13
doc.save(path)
doc.close()

encoded = base64.b64encode(open(path, "rb").read()).decode()
print("=" * 76)
print("CASE 1: DTI 80% (net 10,000 / obligations 8,000) - should generate suggestion")
result = run_workflow(encoded, "high_dti_statement.pdf", "application/pdf", "app-demo", "sugg-high-" + str(y), 50000)
print("status    :", result.get("status"))
print("outcome   :", (result.get("decision") or {}).get("outcome"))
print("dti       :", (result.get("decision") or {}).get("dti_percent"))
print("suggestion:")
print(result.get("suggestion"))
print("explanation:")
print(result.get("explanation"))

print()
print("=" * 76)
print("CASE 2: check2 statement (net 20,000 / obligations 5,000, DTI 25) - must have NO suggestion")
check2 = base64.b64encode(open(r"C:\Users\DurgaGaneshGorrela\OneDrive - The Ksquare Group\Desktop\CapStone\backend\uploads\2613a050-972f-47cc-b8b3-ac34481a6f33.pdf", "rb").read()).decode()
result2 = run_workflow(check2, "sample_bank_statement_check2_aug_oct_2026.pdf", "application/pdf", "app-demo", "sugg-low", 50000)
print("status    :", result2.get("status"))
print("outcome   :", (result2.get("decision") or {}).get("outcome"))
print("dti       :", (result2.get("decision") or {}).get("dti_percent"))
print("suggestion:", result2.get("suggestion"))
print("explanation has 'Suggestion':", "Suggestion" in (result2.get("explanation") or ""))
