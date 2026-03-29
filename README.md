# Reimbursement Manager

AI-powered expense reimbursement platform built with Node.js, Express, EJS, Python, OCR, and MySQL.

## What It Does

The system lets employees upload receipts, runs OCR and validation before submission, stores everything in MySQL, routes claims through a hybrid approval workflow, and surfaces fraud/anomaly signals to reviewers.

Core capabilities:

- company signup with live country-to-currency assignment
- employee, manager, finance, stakeholder, CFO, CEO, and admin role flows
- receipt OCR with `tesseract.js`
- duplicate, shared-bill, mismatch, threshold, and pattern checks
- ML anomaly detection with Python `IsolationForest`
- exchange-rate normalization and logging
- finance, reviewer, and executive dashboards
- full MySQL-backed persistence for claims, fraud flags, currency logs, insights, timelines, and notifications

## Tech Stack

- Node.js + Express
- EJS templates
- MySQL
- Python + scikit-learn
- Tesseract OCR

## Project Structure

```text
src/
  server.js        Express routes
  store.js         Core service/repository logic
  db.js            MySQL pool

sql/
  schema.sql       Normalized MySQL schema
  seed.sql         Demo seed data

ml/
  anomaly_scorer.py

public/
  app.js
  styles.css

views/
  auth and dashboard templates

docs/
  ai-mysql-expense-backend.md
```

## Main Workflow

```text
Upload receipt
-> OCR extraction
-> validation precheck
-> fraud and anomaly scoring
-> currency conversion
-> MySQL persistence
-> approval workflow
-> notifications and insights
```

## Database Design

Main MySQL tables:

- `users`
- `companies`
- `departments`
- `roles`
- `user_roles`
- `claims`
- `approval_steps`
- `timelines`
- `notifications`
- `ai_audits`
- `claim_validation_flags`
- `fraud_flags`
- `currency_logs`
- `expense_insights`

No static JSON is used as the persistent source of truth.

## Setup

1. Create a MySQL database named `reimbursement_manager`.
2. Copy `.env.example` to `.env`.
3. Update MySQL credentials in `.env`.
4. Install Node dependencies:

```powershell
npm install
```

5. Install the Python ML dependency:

```powershell
python -m pip install scikit-learn
```

6. Start the app:

```powershell
npm run dev
```

7. Open:

```text
http://localhost:3000
```

## Demo Users

Password for seeded users:

```text
demo123
```

Examples:

- `employee@test.com`
- `employee2@test.com`
- `employee3@test.com`
- `manager@test.com`
- `manager2@test.com`
- `finance@test.com`
- `cfo@test.com`
- `ceo@test.com`
- `admin@test.com`

## AI Features Implemented

### OCR + Parsing

- extracts receipt text
- parses vendor, date, amount, and bill reference

### Validation

- suspicious bill detection
- OCR vs entered amount mismatch
- duplicate bill detection
- shared bill detection across employees
- same employee duplicate detection
- vendor/date/amount repeat pattern detection
- threshold checks

### ML Fraud Scoring

- uses historical MySQL claim data
- runs Python `IsolationForest`
- feeds anomaly warnings back into the precheck flow

## Currency Services

Uses:

- countries and currencies:
  `https://restcountries.com/v3.1/all?fields=name,currencies`
- exchange rates:
  `https://api.exchangerate-api.com/v4/latest/{BASE_CURRENCY}`

## Approval Logic

- manager is the first mandatory gate
- if manager rejects, the process ends
- after manager approval, claim goes to department head, finance, stakeholders, and CFO
- CFO approval is an independent shortcut
- otherwise 60% consensus among non-CFO reviewers decides approval
- CEO can override

## Notes

- schema and seed scripts run automatically on startup
- this repo currently keeps backend logic in `src/store.js`; it can be split into controllers/services/repositories later
- for a deeper backend breakdown, see [docs/ai-mysql-expense-backend.md](docs/ai-mysql-expense-backend.md)
