# AI-Powered Expense Reimbursement Backend

## System Architecture

```text
Client / UI
  -> REST API (Express)
    -> Controllers
      -> Services
        -> Repositories
          -> MySQL
        -> OCR Engine (Tesseract)
        -> Fraud / Validation Engine
        -> FX Service (ExchangeRate API)
        -> Insight Engine
        -> Notification Logger
```

### End-to-End Flow

```text
Upload Receipt
  -> OCR text extraction
  -> Smart parsing (vendor, amount, date, bill ref)
  -> Save expense/claim in MySQL
  -> Validation checks
  -> Fraud + duplicate + shared-bill checks
  -> Currency conversion + log
  -> Historical insight generation
  -> Notification logging
  -> Approval workflow
```

## Normalized MySQL Schema

Core tables already implemented or extended in this codebase:

- `users`
- `companies`
- `departments`
- `roles`
- `user_roles`
- `claims` (domain expense record)
- `approval_steps`
- `timelines`
- `notifications`
- `ai_audits`
- `claim_validation_flags`
- `fraud_flags`
- `currency_logs`
- `expense_insights`

### Notes

- The current runtime table is `claims`; this is the persistent expense record.
- If you want naming parity with the word `expenses`, add a MySQL view:

```sql
CREATE OR REPLACE VIEW expenses AS
SELECT * FROM claims;
```

## Key DDL Snippets

### Expense Record

```sql
CREATE TABLE claims (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employee_user_id INT NOT NULL,
  manager_user_id INT NOT NULL,
  category_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reported_currency VARCHAR(10) NOT NULL,
  company_currency VARCHAR(10) NOT NULL,
  exchange_rate DECIMAL(12,6) NOT NULL,
  converted_amount DECIMAL(12,2) NOT NULL,
  expense_date DATE NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  ocr_vendor VARCHAR(255),
  ocr_bill_ref VARCHAR(120),
  ocr_amount DECIMAL(12,2),
  ocr_date DATE,
  ocr_status VARCHAR(40) NOT NULL,
  authenticity_status VARCHAR(40) NOT NULL,
  risk_score INT NOT NULL DEFAULT 0,
  ai_summary TEXT,
  employee_justification TEXT NULL,
  formatted_request TEXT,
  status VARCHAR(60) NOT NULL DEFAULT 'pending_manager',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Fraud Flags

```sql
CREATE TABLE fraud_flags (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  employee_user_id INT NOT NULL,
  flag_type VARCHAR(80) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  confidence_score DECIMAL(5,2) NOT NULL DEFAULT 0,
  flag_message TEXT NOT NULL,
  review_status VARCHAR(30) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Currency Logs

```sql
CREATE TABLE currency_logs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  base_currency VARCHAR(10) NOT NULL,
  target_currency VARCHAR(10) NOT NULL,
  exchange_rate DECIMAL(12,6) NOT NULL,
  source_api VARCHAR(160) NOT NULL,
  original_amount DECIMAL(12,2) NOT NULL,
  converted_amount DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Insights

```sql
CREATE TABLE expense_insights (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NULL,
  employee_user_id INT NULL,
  category_id INT NULL,
  company_id INT NULL,
  insight_type VARCHAR(80) NOT NULL,
  metric_value DECIMAL(14,2) NOT NULL,
  metric_currency VARCHAR(10) NULL,
  insight_text TEXT NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Suggested Folder Structure

```text
src/
  controllers/
    authController.js
    expenseController.js
    approvalController.js
    analyticsController.js
  services/
    authService.js
    expenseService.js
    ocrService.js
    fraudService.js
    currencyService.js
    insightService.js
    notificationService.js
  repositories/
    userRepository.js
    expenseRepository.js
    fraudRepository.js
    currencyRepository.js
    insightRepository.js
    notificationRepository.js
  routes/
    authRoutes.js
    expenseRoutes.js
    approvalRoutes.js
    analyticsRoutes.js
  db.js
  server.js
```

### Current Repo Mapping

- `src/server.js` currently contains the route layer.
- `src/store.js` currently contains mixed repository/service logic.
- Recommended refactor: split `store.js` into controllers/services/repositories as above.

## REST API Endpoints

### Expense APIs

- `POST /claims/precheck`
- `POST /claims`
- `GET /dashboard/employee`
- `GET /dashboard/manager`
- `GET /dashboard/finance`
- `POST /claims/:claimId/approve`
- `POST /claims/:claimId/reject`
- `POST /reviews/:claimId/approve`
- `POST /reviews/:claimId/reject`
- `POST /ceo/:claimId/:decision`

### Suggested CRUD-style Expense APIs

- `POST /api/expenses`
- `GET /api/expenses/:id`
- `GET /api/expenses`
- `PATCH /api/expenses/:id`
- `DELETE /api/expenses/:id`
- `GET /api/expenses/:id/flags`
- `GET /api/expenses/:id/insights`
- `GET /api/analytics/trends`

## Key Backend Snippets

### OCR + Parsing

```js
const result = await Tesseract.recognize(receipt.buffer, "eng");
const text = result?.data?.text?.trim() || "";
const amount = parseOcrAmount(text);
const date = parseOcrDate(text);
const vendor = parseOcrVendor(text, receipt);
const billRef = parseOcrBillRef(text);
```

### Duplicate Check

```sql
SELECT id, employee_user_id
FROM claims
WHERE receipt_hash = ?;
```

### Shared-Bill / Similar Pattern Check

```sql
SELECT employee_user_id, ocr_vendor, ocr_amount, ocr_date
FROM claims
WHERE employee_user_id <> ?
  AND ocr_date = ?
  AND ABS(IFNULL(ocr_amount, 0) - ?) <= 1;
```

### Currency Log Write

```sql
INSERT INTO currency_logs
  (claim_id, base_currency, target_currency, exchange_rate, source_api, original_amount, converted_amount)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

### Insight Generation Query

```sql
SELECT ROUND(IFNULL(AVG(c.converted_amount), 0), 2) AS avg_amount
FROM claims c
JOIN users u ON u.id = c.employee_user_id
WHERE c.category_id = ? AND u.company_id = ?;
```

## AI Integration with MySQL Data

### 1. OCR Pipeline

- Receipt image is uploaded.
- OCR text is extracted.
- Parsed fields are persisted into `claims` and `ai_audits`.

### 2. Fraud / Duplicate Detection

- Exact duplicate: `receipt_hash`
- Shared bill: same hash across employees
- Similar expense: same vendor + amount + date
- Repeated employee duplicate: same employee + same hash
- Suspicious OCR: weak parse / missing bill reference / failed OCR

Results are persisted in:

- `fraud_flags`
- `claim_validation_flags`
- `ai_audits`

### 3. Currency Normalization

- Uses `https://api.exchangerate-api.com/v4/latest/{BASE_CURRENCY}`
- Stores original amount, converted amount, rate, and API source in `currency_logs`
- Normalized value is written to `claims.converted_amount`

### 4. Insight Engine

Pulls historical data from MySQL:

- employee average spend
- category average spend
- company average spend
- delta from category average

Persists computed metrics in:

- `expense_insights`

### 5. Future Anomaly Detection

Recommended training data query:

```sql
SELECT
  c.id,
  c.employee_user_id,
  c.category_id,
  c.converted_amount,
  c.risk_score,
  c.ocr_amount,
  c.expense_date,
  IFNULL(a.duplicate_flag, 0) AS duplicate_flag,
  IFNULL(a.shared_bill_flag, 0) AS shared_bill_flag,
  IFNULL(a.amount_mismatch_flag, 0) AS amount_mismatch_flag,
  IFNULL(a.unusual_flag, 0) AS unusual_flag
FROM claims c
LEFT JOIN ai_audits a ON a.claim_id = c.id;
```

That dataset can feed Isolation Forest or another anomaly model. The model output should be persisted back into `fraud_flags` with:

- `flag_type = 'anomaly_score'`
- `confidence_score`
- `flag_message`

## Why This Meets the Requirement

- Persistent business data is in MySQL.
- Fraud, OCR, FX, validation, and insight outputs are all queryable from MySQL.
- No static JSON files are used as the source of truth for persistent system behavior.
- APIs are designed around relational writes and reads, not file-based state.
