# Reimbursement Manager

Demo-ready reimbursement system built with Node.js, Express, EJS, and MySQL.

## Features

- Smart company setup with country-to-currency mapping
- Role-driven approval flows stored in MySQL tables
- Employee claim submission with receipt upload
- AI-style validation for duplicate receipt reuse, amount mismatch, and unusual spend
- Manager queue with one-click approve/reject
- Finance dashboard with department spend and flagged claims

## Run

1. Create a MySQL database named `reimbursement_manager`.
2. Copy `.env.example` to `.env` and update credentials.
3. Run `npm install`
4. Run `npm run dev`
5. Open `http://localhost:3000`

## Notes

- Schema and seed scripts run automatically on startup.
- Receipt OCR is currently simulated for demo purposes.
- Approval flows are relational in MySQL, not static JSON.
