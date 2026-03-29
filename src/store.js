const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const Tesseract = require("tesseract.js");
const { pool } = require("./db");

const ROLE_REDIRECTS = {
  admin: "/dashboard/admin",
  employee: "/dashboard/employee",
  manager: "/dashboard/manager",
  finance: "/dashboard/finance",
  cfo: "/dashboard/cfo",
  ceo: "/dashboard/ceo",
  department_head: "/dashboard/reviewer",
  ops: "/dashboard/reviewer",
  procurement: "/dashboard/reviewer",
  tech_head: "/dashboard/reviewer",
  marketing_head: "/dashboard/reviewer",
  senior_manager: "/dashboard/reviewer",
};

let countryCurrencyCache = null;
let countryCurrencyCacheAt = 0;
const COUNTRY_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const FALLBACK_COUNTRY_ROWS = [
  { country: "India", currency: "INR" },
  { country: "United States", currency: "USD" },
  { country: "Germany", currency: "EUR" },
  { country: "United Kingdom", currency: "GBP" },
  { country: "Singapore", currency: "SGD" },
  { country: "United Arab Emirates", currency: "AED" },
];

const STATUS_LABELS = {
  pending_manager: "Pending Manager Approval",
  under_review_finance: "Under Review of Finance Dept",
  under_review_ops: "Under Review of Operations",
  under_review_department_head: "Under Review of Department Head",
  under_review_procurement: "Under Review of Procurement",
  under_review_marketing_head: "Under Review of Marketing Head",
  under_review_tech_head: "Under Review of Tech Dept Head",
  under_parallel_review: "Under Review of Finance Dept and Stakeholders",
  approved: "Approved",
  disapproved_by_manager: "Disapproved by Manager",
  disapproved_by_finance: "Disapproved by Finance Dept",
  disapproved_by_ops: "Disapproved by Operations",
  disapproved_by_department_head: "Disapproved by Department Head",
  disapproved_by_procurement: "Disapproved by Procurement",
  disapproved_by_marketing_head: "Disapproved by Marketing Head",
  disapproved_by_tech_head: "Disapproved by Tech Dept Head",
  rejected_rule_engine: "Rejected by Rule Engine",
  force_approved_by_ceo: "Force Approved by CEO",
  force_rejected_by_ceo: "Force Rejected by CEO",
};

async function initDatabase() {
  const schema = await fs.readFile(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(schema);
  await runMigrations();
  const seed = await fs.readFile(path.join(__dirname, "..", "sql", "seed.sql"), "utf8");
  await pool.query(seed);
  await ensureDemoUsers();
  await migrateLegacyApprovalFlows();
}

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function tableExists(tableName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function foreignKeyExists(tableName, constraintName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [tableName, constraintName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function runMigrations() {
  if (!(await columnExists("users", "password"))) {
    await pool.query("ALTER TABLE users ADD COLUMN password VARCHAR(160) NOT NULL DEFAULT 'demo123' AFTER email");
  }
  if (!(await columnExists("users", "company_id"))) {
    await pool.query("ALTER TABLE users ADD COLUMN company_id INT NULL AFTER password");
  }
  if (!(await foreignKeyExists("users", "fk_users_company"))) {
    try {
      await pool.query("ALTER TABLE users ADD CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies(id)");
    } catch (error) {
      if (!["ER_DUP_KEYNAME", "ER_CANT_CREATE_TABLE"].includes(error.code)) {
        throw error;
      }
    }
  }

  const claimColumns = [
    ["reported_currency", "VARCHAR(10) NOT NULL DEFAULT 'INR' AFTER amount"],
    ["company_currency", "VARCHAR(10) NOT NULL DEFAULT 'INR' AFTER reported_currency"],
    ["exchange_rate", "DECIMAL(12,6) NOT NULL DEFAULT 1 AFTER company_currency"],
    ["converted_amount", "DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER exchange_rate"],
    ["remarks", "TEXT NULL AFTER description"],
    ["ocr_bill_ref", "VARCHAR(120) NULL AFTER ocr_vendor"],
    ["ocr_status", "VARCHAR(40) NOT NULL DEFAULT 'checked' AFTER ocr_date"],
    ["authenticity_status", "VARCHAR(40) NOT NULL DEFAULT 'authentic' AFTER ocr_status"],
    ["employee_justification", "TEXT NULL AFTER ai_summary"],
    ["formatted_request", "TEXT NULL AFTER ai_summary"],
  ];
  for (const [name, sql] of claimColumns) {
    if (!(await columnExists("claims", name))) {
      await pool.query(`ALTER TABLE claims ADD COLUMN ${name} ${sql}`);
    }
  }

  if (!(await tableExists("notifications"))) {
    await pool.query(`
      CREATE TABLE notifications (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        claim_id INT NULL,
        title VARCHAR(160) NOT NULL,
        body TEXT NOT NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
      )
    `);
  }

  if (await tableExists("ai_audits")) {
    const auditColumns = [
      ["ocr_bill_ref", "VARCHAR(120) NULL AFTER ocr_vendor"],
      ["shared_bill_flag", "TINYINT(1) NOT NULL DEFAULT 0 AFTER duplicate_flag"],
      ["shared_bill_count", "INT NOT NULL DEFAULT 0 AFTER shared_bill_flag"],
    ];
    for (const [name, sql] of auditColumns) {
      if (!(await columnExists("ai_audits", name))) {
        await pool.query(`ALTER TABLE ai_audits ADD COLUMN ${name} ${sql}`);
      }
    }
  }

  if (!(await tableExists("claim_validation_flags"))) {
    await pool.query(`
      CREATE TABLE claim_validation_flags (
        id INT PRIMARY KEY AUTO_INCREMENT,
        claim_id INT NOT NULL,
        flag_code VARCHAR(80) NOT NULL,
        flag_title VARCHAR(160) NOT NULL,
        flag_message TEXT NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_claim_validation_flags_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
      )
    `);
  }

  if (!(await tableExists("fraud_flags"))) {
    await pool.query(`
      CREATE TABLE fraud_flags (
        id INT PRIMARY KEY AUTO_INCREMENT,
        claim_id INT NOT NULL,
        employee_user_id INT NOT NULL,
        flag_type VARCHAR(80) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'warning',
        confidence_score DECIMAL(5,2) NOT NULL DEFAULT 0,
        flag_message TEXT NOT NULL,
        review_status VARCHAR(30) NOT NULL DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_fraud_flags_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
        CONSTRAINT fk_fraud_flags_employee FOREIGN KEY (employee_user_id) REFERENCES users(id)
      )
    `);
  }

  if (!(await tableExists("currency_logs"))) {
    await pool.query(`
      CREATE TABLE currency_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        claim_id INT NOT NULL,
        base_currency VARCHAR(10) NOT NULL,
        target_currency VARCHAR(10) NOT NULL,
        exchange_rate DECIMAL(12,6) NOT NULL,
        source_api VARCHAR(160) NOT NULL,
        original_amount DECIMAL(12,2) NOT NULL,
        converted_amount DECIMAL(12,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_currency_logs_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
      )
    `);
  }

  if (!(await tableExists("expense_insights"))) {
    await pool.query(`
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
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_expense_insights_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
        CONSTRAINT fk_expense_insights_employee FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_expense_insights_category FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
        CONSTRAINT fk_expense_insights_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
      )
    `);
  }
}

async function getCountryCurrencyRows() {
  const now = Date.now();
  if (countryCurrencyCache && now - countryCurrencyCacheAt < COUNTRY_CACHE_TTL_MS) {
    return countryCurrencyCache;
  }

  try {
    const response = await fetch("https://restcountries.com/v3.1/all?fields=name,currencies");
    if (!response.ok) {
      throw new Error(`Country API returned ${response.status}`);
    }
    const countries = await response.json();
    const rows = countries
      .map((item) => {
        const country = item?.name?.common;
        const currency = Object.keys(item?.currencies || {})[0];
        if (!country || !currency) {
          return null;
        }
        return { country, currency };
      })
      .filter(Boolean)
      .sort((left, right) => left.country.localeCompare(right.country));

    if (rows.length) {
      countryCurrencyCache = rows;
      countryCurrencyCacheAt = now;
      return rows;
    }
  } catch (error) {
    console.warn("Country API fallback", error.message);
  }

  countryCurrencyCache = FALLBACK_COUNTRY_ROWS;
  countryCurrencyCacheAt = now;
  return countryCurrencyCache;
}

async function inferCurrencyFromCountry(country) {
  const rows = await getCountryCurrencyRows();
  return rows.find((row) => row.country === country)?.currency || "USD";
}

function getRoleRedirect(roleCode) {
  return ROLE_REDIRECTS[roleCode] || "/dashboard/employee";
}

function getRoleLabel(roleCode) {
  const labels = {
    admin: "Admin View",
    employee: "Employee View",
    manager: "Manager View",
    finance: "Finance View",
    cfo: "Executive View",
    ceo: "CEO Override",
    department_head: "Department Head View",
    ops: "Operations View",
    procurement: "Procurement View",
    tech_head: "Tech Head View",
    marketing_head: "Marketing Head View",
    senior_manager: "Stakeholder View",
  };
  return labels[roleCode] || "Workspace";
}

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status.replaceAll("_", " ");
}

function getReviewStatus(roleCode) {
  const map = {
    finance: "under_review_finance",
    ops: "under_review_ops",
    department_head: "under_review_department_head",
    procurement: "under_review_procurement",
    marketing_head: "under_review_marketing_head",
    tech_head: "under_review_tech_head",
  };
  return map[roleCode] || "pending_manager";
}

function getRejectStatus(roleCode) {
  const map = {
    manager: "disapproved_by_manager",
    finance: "disapproved_by_finance",
    ops: "disapproved_by_ops",
    department_head: "disapproved_by_department_head",
    procurement: "disapproved_by_procurement",
    marketing_head: "disapproved_by_marketing_head",
    tech_head: "disapproved_by_tech_head",
  };
  return map[roleCode] || "rejected";
}

function formatRequest(payload) {
  return [
    `Category: ${payload.categoryName}`,
    `Amount: ${payload.currency} ${payload.amount}`,
    `Expense Date: ${payload.expenseDate}`,
    `Vendor: ${payload.vendor}`,
    `Description: ${payload.description}`,
    `AI Summary: ${payload.summary}`,
  ].join(" | ");
}

function getFileVendorFallback(receipt) {
  const fileName = receipt?.originalname || "receipt.jpg";
  return fileName.replace(path.extname(fileName), "").replace(/[_-]/g, " ");
}

function parseOcrAmount(text) {
  const normalized = (text || "").replace(/,/g, "");
  const currencyFirst = normalized.match(/(?:INR|USD|EUR|GBP|SGD|AED|Rs\.?|₹|\$|€|£)\s*([0-9]+(?:\.[0-9]{2})?)/i);
  if (currencyFirst?.[1]) {
    return Number(currencyFirst[1]);
  }

  const totalLine = normalized.match(/(?:grand\s+total|total\s+amount|amount\s+due|total)\D{0,12}([0-9]+(?:\.[0-9]{2})?)/i);
  if (totalLine?.[1]) {
    return Number(totalLine[1]);
  }

  const allNumbers = [...normalized.matchAll(/\b([0-9]{1,6}(?:\.[0-9]{2})?)\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 0);
  if (!allNumbers.length) {
    return null;
  }
  return Math.max(...allNumbers);
}

function parseOcrDate(text) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(\d{4}[-/]\d{2}[-/]\d{2})\b/,
    /\b(\d{2}[-/]\d{2}[-/]\d{4})\b/,
    /\b(\d{2}\s+[A-Za-z]{3,9}\s+\d{4})\b/,
    /\b([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\b/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = new Date(match[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  return null;
}

function parseOcrVendor(text, receipt) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const vendorLine = lines.find((line) => /(?:ltd|limited|inc|llc|store|hotel|cafe|airways|technologies|solutions)/i.test(line));
  if (vendorLine) {
    return vendorLine.slice(0, 120);
  }

  const firstMeaningfulLine = lines.find((line) => line.length > 3 && !/[0-9]{2,}/.test(line));
  return firstMeaningfulLine?.slice(0, 120) || getFileVendorFallback(receipt);
}

function parseOcrBillRef(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const match = normalized.match(/(?:invoice|bill|receipt|ref(?:erence)?|txn|transaction)\s*(?:no|number|#)?[:\-\s]*([A-Z0-9\-]{4,30})/i);
  return match?.[1] || null;
}

function normalizeVendor(vendor) {
  return String(vendor || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function detectSharedBill(connection, employeeId, receiptHash, ocr) {
  const [sameReceiptRows] = await connection.query(
    `SELECT DISTINCT employee_user_id
     FROM claims
     WHERE receipt_hash = ? AND employee_user_id <> ?`,
    [receiptHash, employeeId]
  );

  let similarRows = [];
  const normalizedVendor = normalizeVendor(ocr.vendor);
  if (normalizedVendor && ocr.date && ocr.amount) {
    const [rows] = await connection.query(
      `SELECT employee_user_id, ocr_vendor, ocr_amount, ocr_date
       FROM claims
       WHERE employee_user_id <> ?
         AND ocr_date = ?
         AND ABS(IFNULL(ocr_amount, 0) - ?) <= 1`,
      [employeeId, ocr.date, Number(ocr.amount)]
    );
    similarRows = rows.filter((row) => normalizeVendor(row.ocr_vendor) === normalizedVendor);
  }

  const matchedEmployees = new Set([
    ...sameReceiptRows.map((row) => row.employee_user_id),
    ...similarRows.map((row) => row.employee_user_id),
  ]);

  return {
    sharedBillFlag: matchedEmployees.size > 0,
    sharedBillCount: matchedEmployees.size,
  };
}

async function runReceiptOcr(receipt, reportedAmount, expenseDate) {
  const fallback = {
    vendor: getFileVendorFallback(receipt),
    billRef: null,
    amount: Number(reportedAmount),
    date: expenseDate,
    text: "",
    status: "fallback",
  };

  if (!receipt?.buffer?.length) {
    return fallback;
  }

  try {
    const result = await Tesseract.recognize(receipt.buffer, "eng", {
      logger: () => {},
    });
    const text = result?.data?.text?.trim() || "";
    if (!text) {
      return fallback;
    }

    const parsedAmount = parseOcrAmount(text);
    const parsedDate = parseOcrDate(text);
    const parsedVendor = parseOcrVendor(text, receipt);
    const parsedBillRef = parseOcrBillRef(text);
    const foundSignals = [parsedAmount, parsedDate, parsedVendor].filter(Boolean).length;

    return {
      vendor: parsedVendor || fallback.vendor,
      billRef: parsedBillRef,
      amount: parsedAmount ?? Number(reportedAmount),
      date: parsedDate || expenseDate,
      text,
      status: foundSignals >= 2 ? "extracted" : "partial",
    };
  } catch (error) {
    console.warn("OCR failed, using fallback values", error.message);
    return {
      ...fallback,
      billRef: null,
      status: "failed",
    };
  }
}

async function getExchangeRate(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
    return 1;
  }
  try {
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${encodeURIComponent(fromCurrency)}`);
    const data = await response.json();
    if (data?.rates?.[toCurrency]) {
      return Number(data.rates[toCurrency]);
    }
  } catch (error) {
    console.warn("Exchange rate API fallback", error.message);
  }
  return 1;
}

async function getMlAnomalyAssessment(candidate) {
  const scriptPath = path.join(__dirname, "..", "ml", "anomaly_scorer.py");
  const payload = {
    db: {
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "reimbursement_manager",
    },
    candidate,
  };

  return new Promise((resolve) => {
    const python = spawn("python", [scriptPath], {
      cwd: path.join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    python.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    python.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    python.on("error", (error) => {
      resolve({
        available: false,
        anomaly_score: null,
        is_anomaly: false,
        message: error.message,
      });
    });
    python.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        resolve({
          available: Boolean(parsed.available),
          anomaly_score: parsed.anomaly_score == null ? null : Number(parsed.anomaly_score),
          is_anomaly: Boolean(parsed.is_anomaly),
          message: parsed.message || stderr.trim() || "ML scorer returned no message",
        });
      } catch (error) {
        resolve({
          available: false,
          anomaly_score: null,
          is_anomaly: false,
          message: stderr.trim() || error.message,
        });
      }
    });

    python.stdin.write(JSON.stringify(payload));
    python.stdin.end();
  });
}

async function getCategoryById(categoryId) {
  const [rows] = await pool.query("SELECT * FROM expense_categories WHERE id = ?", [categoryId]);
  return rows[0] || null;
}

async function getPrimaryRole(userId) {
  const [rows] = await pool.query(
    `SELECT r.code, r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?
     ORDER BY FIELD(r.code, 'admin', 'employee', 'manager', 'finance', 'cfo', 'department_head', 'ops', 'tech_head', 'procurement', 'marketing_head', 'senior_manager')
     LIMIT 1`,
    [userId]
  );
  return rows[0] || { code: "employee", name: "Employee" };
}

async function getUserById(userId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.company_id, u.department_id, u.manager_user_id, c.name AS company_name, c.country, c.currency_code
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  if (!rows[0]) {
    return null;
  }
  const role = await getPrimaryRole(userId);
  return { ...rows[0], role_code: role.code, role_name: role.name };
}

async function authenticateUser(email, password) {
  const [rows] = await pool.query(
    `SELECT u.id
     FROM users u
     WHERE u.email = ? AND u.password = ?
     LIMIT 1`,
    [email, password]
  );
  return rows[0] ? getUserById(rows[0].id) : null;
}

async function createNotification(connection, userId, claimId, title, body) {
  await connection.query(
    "INSERT INTO notifications (user_id, claim_id, title, body) VALUES (?, ?, ?, ?)",
    [userId, claimId || null, title, body]
  );
}

async function logTimeline(connection, claimId, label, actorUserId = null) {
  await connection.query(
    "INSERT INTO timelines (claim_id, actor_user_id, event_label) VALUES (?, ?, ?)",
    [claimId, actorUserId, label]
  );
}

async function createAiAudit(connection, claimId, payload) {
  await connection.query(
    `INSERT INTO ai_audits
      (claim_id, receipt_hash, ocr_vendor, ocr_bill_ref, ocr_amount, ocr_date, duplicate_flag, shared_bill_flag, shared_bill_count, amount_mismatch_flag, unusual_flag, risk_score, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      payload.receiptHash,
      payload.ocr.vendor,
      payload.ocr.billRef,
      payload.ocr.amount,
      payload.ocr.date,
      payload.duplicateFlag ? 1 : 0,
      payload.sharedBillFlag ? 1 : 0,
      payload.sharedBillCount || 0,
      payload.amountMismatchFlag ? 1 : 0,
      payload.unusualFlag ? 1 : 0,
      payload.riskScore,
      payload.summary,
    ]
  );
}

async function createValidationFlagRows(connection, claimId, warnings) {
  for (const warning of warnings || []) {
    await connection.query(
      `INSERT INTO claim_validation_flags (claim_id, flag_code, flag_title, flag_message, severity)
       VALUES (?, ?, ?, ?, ?)`,
      [claimId, warning.code, warning.title, warning.message, warning.severity || "warning"]
    );
  }
}

async function createFraudFlagRows(connection, claimId, employeeUserId, warnings, riskScore) {
  for (const warning of warnings || []) {
    await connection.query(
      `INSERT INTO fraud_flags (claim_id, employee_user_id, flag_type, severity, confidence_score, flag_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        claimId,
        employeeUserId,
        warning.code,
        warning.severity || "warning",
        Math.min(99.99, Number(riskScore || 0)),
        warning.message,
      ]
    );
  }
}

async function createCurrencyLog(connection, claimId, baseCurrency, targetCurrency, exchangeRate, originalAmount, convertedAmount) {
  await connection.query(
    `INSERT INTO currency_logs (claim_id, base_currency, target_currency, exchange_rate, source_api, original_amount, converted_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      baseCurrency,
      targetCurrency,
      exchangeRate,
      "https://api.exchangerate-api.com/v4/latest/{BASE_CURRENCY}",
      Number(originalAmount),
      Number(convertedAmount),
    ]
  );
}

async function createExpenseInsightRows(connection, claimId, employeeUserId, categoryId, companyId, amount, companyCurrency) {
  const [[employeeAvgRow]] = await connection.query(
    `SELECT ROUND(IFNULL(AVG(converted_amount), 0), 2) AS avg_amount
     FROM claims
     WHERE employee_user_id = ? AND id <> ?`,
    [employeeUserId, claimId]
  );
  const [[categoryAvgRow]] = await connection.query(
    `SELECT ROUND(IFNULL(AVG(c.converted_amount), 0), 2) AS avg_amount
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     WHERE c.category_id = ? AND u.company_id = ? AND c.id <> ?`,
    [categoryId, companyId, claimId]
  );
  const [[companyAvgRow]] = await connection.query(
    `SELECT ROUND(IFNULL(AVG(c.converted_amount), 0), 2) AS avg_amount
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     WHERE u.company_id = ? AND c.id <> ?`,
    [companyId, claimId]
  );

  const insightRows = [
    {
      type: "employee_average",
      value: Number(employeeAvgRow?.avg_amount || 0),
      text: `Employee historical average spend is ${companyCurrency} ${Number(employeeAvgRow?.avg_amount || 0).toFixed(2)}.`,
    },
    {
      type: "category_average",
      value: Number(categoryAvgRow?.avg_amount || 0),
      text: `Category historical average spend is ${companyCurrency} ${Number(categoryAvgRow?.avg_amount || 0).toFixed(2)}.`,
    },
    {
      type: "company_average",
      value: Number(companyAvgRow?.avg_amount || 0),
      text: `Company average spend across expense claims is ${companyCurrency} ${Number(companyAvgRow?.avg_amount || 0).toFixed(2)}.`,
    },
    {
      type: "claim_delta_from_category_avg",
      value: Number(amount) - Number(categoryAvgRow?.avg_amount || 0),
      text: `This claim is ${(Number(amount) - Number(categoryAvgRow?.avg_amount || 0)).toFixed(2)} ${companyCurrency} from the category average.`,
    },
  ];

  for (const row of insightRows) {
    await connection.query(
      `INSERT INTO expense_insights (claim_id, employee_user_id, category_id, company_id, insight_type, metric_value, metric_currency, insight_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [claimId, employeeUserId, categoryId, companyId, row.type, row.value, companyCurrency, row.text]
    );
  }
}

async function createCompanySetup({ company_name, country, email, password }) {
  if (!company_name || !country || !email || !password) {
    throw new Error("All signup fields are required.");
  }

  const currency = await inferCurrencyFromCountry(country);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [companyResult] = await connection.query(
      `INSERT INTO companies (name, country, currency_code)
       VALUES (?, ?, ?)`,
      [company_name, country, currency]
    );
    const companyId = companyResult.insertId;
    const [userResult] = await connection.query(
      `INSERT INTO users (full_name, email, password, company_id)
       VALUES (?, ?, ?, ?)`,
      [`${company_name} Admin`, email, password, companyId]
    );
    const [roleRows] = await connection.query("SELECT id FROM roles WHERE code = 'admin' LIMIT 1");
    await connection.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [
      userResult.insertId,
      roleRows[0].id,
    ]);
    await connection.commit();
    return { companyId, currency, adminEmail: email };
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("This company or email already exists.");
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureUserRole(connection, userId, roleCode) {
  const [roleRows] = await connection.query("SELECT id FROM roles WHERE code = ? LIMIT 1", [roleCode]);
  if (!roleRows[0]) {
    return;
  }
  await connection.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [
    userId,
    roleRows[0].id,
  ]);
}

async function ensureDemoUsers() {
  const demoUsers = [
    { full_name: "Asha Employee", email: "employee@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "employee" },
    { full_name: "Neha Employee", email: "employee2@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "employee" },
    { full_name: "Karthik Employee", email: "employee3@test.com", password: "demo123", company_id: 1, department_id: 2, manager_user_id: null, role: "employee" },
    { full_name: "Ravi Manager", email: "manager@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "manager" },
    { full_name: "Maya Manager", email: "manager2@test.com", password: "demo123", company_id: 1, department_id: 2, manager_user_id: null, role: "manager" },
    { full_name: "Nina Finance", email: "finance@test.com", password: "demo123", company_id: 1, department_id: 4, manager_user_id: null, role: "finance" },
    { full_name: "Omar Operations", email: "ops@test.com", password: "demo123", company_id: 1, department_id: 3, manager_user_id: null, role: "ops" },
    { full_name: "Priya Tech Head", email: "techhead@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "tech_head" },
    { full_name: "Karan Procurement", email: "procurement@test.com", password: "demo123", company_id: 1, department_id: 5, manager_user_id: null, role: "procurement" },
    { full_name: "Meera Marketing Head", email: "marketing@test.com", password: "demo123", company_id: 1, department_id: 2, manager_user_id: null, role: "marketing_head" },
    { full_name: "Dev Department Head", email: "depthead@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "department_head" },
    { full_name: "Sara Senior Manager", email: "senior@test.com", password: "demo123", company_id: 1, department_id: 1, manager_user_id: null, role: "senior_manager" },
    { full_name: "CFO Demo", email: "cfo@test.com", password: "demo123", company_id: 1, department_id: 4, manager_user_id: null, role: "cfo" },
    { full_name: "CEO Demo", email: "ceo@test.com", password: "demo123", company_id: 1, department_id: 4, manager_user_id: null, role: "ceo" },
    { full_name: "Admin Demo", email: "admin@test.com", password: "demo123", company_id: 1, department_id: 4, manager_user_id: null, role: "admin" },
  ];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let managerUserId = null;
    let secondManagerUserId = null;

    for (const user of demoUsers) {
      const [existingRows] = await connection.query("SELECT id FROM users WHERE email = ? LIMIT 1", [user.email]);
      let userId;
      if (existingRows[0]) {
        userId = existingRows[0].id;
        await connection.query(
          `UPDATE users
           SET full_name = ?, password = ?, company_id = ?, department_id = ?
           WHERE id = ?`,
          [user.full_name, user.password, user.company_id, user.department_id, userId]
        );
      } else {
        const [insertResult] = await connection.query(
          `INSERT INTO users (full_name, email, password, company_id, department_id)
           VALUES (?, ?, ?, ?, ?)`,
          [user.full_name, user.email, user.password, user.company_id, user.department_id]
        );
        userId = insertResult.insertId;
      }

      await ensureUserRole(connection, userId, user.role);
      if (user.role === "manager") {
        if (user.email === "manager@test.com") {
          managerUserId = userId;
        } else if (user.email === "manager2@test.com") {
          secondManagerUserId = userId;
        }
      }
    }

    if (managerUserId) {
      await connection.query(
        "UPDATE users SET manager_user_id = ? WHERE email = 'employee@test.com'",
        [managerUserId]
      );
      await connection.query(
        "UPDATE users SET manager_user_id = ? WHERE email = 'employee2@test.com'",
        [managerUserId]
      );
    }
    if (secondManagerUserId) {
      await connection.query(
        "UPDATE users SET manager_user_id = ? WHERE email = 'employee3@test.com'",
        [secondManagerUserId]
      );
    }

    const legacyToCanonical = [
      ["ravi@demo.com", "manager@test.com"],
      ["nina@demo.com", "finance@test.com"],
      ["omar@demo.com", "ops@test.com"],
      ["priya@demo.com", "techhead@test.com"],
      ["karan@demo.com", "procurement@test.com"],
      ["meera@demo.com", "marketing@test.com"],
      ["dev@demo.com", "depthead@test.com"],
      ["cfo@demo.com", "cfo@test.com"],
    ];

    for (const [legacyEmail, canonicalEmail] of legacyToCanonical) {
      const [legacyRows] = await connection.query("SELECT id FROM users WHERE email = ? LIMIT 1", [legacyEmail]);
      const [canonicalRows] = await connection.query("SELECT id FROM users WHERE email = ? LIMIT 1", [canonicalEmail]);
      if (!legacyRows[0] || !canonicalRows[0] || legacyRows[0].id === canonicalRows[0].id) {
        continue;
      }

      const legacyId = legacyRows[0].id;
      const canonicalId = canonicalRows[0].id;

      await connection.query("UPDATE users SET manager_user_id = ? WHERE manager_user_id = ?", [canonicalId, legacyId]);
      await connection.query("UPDATE claims SET manager_user_id = ? WHERE manager_user_id = ?", [canonicalId, legacyId]);
      await connection.query("UPDATE approval_steps SET approver_user_id = ? WHERE approver_user_id = ?", [canonicalId, legacyId]);
      await connection.query("UPDATE timelines SET actor_user_id = ? WHERE actor_user_id = ?", [canonicalId, legacyId]);
      await connection.query("UPDATE notifications SET user_id = ? WHERE user_id = ?", [canonicalId, legacyId]);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function migrateLegacyApprovalFlows() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [claims] = await connection.query(
      `SELECT DISTINCT c.id, u.company_id
       FROM claims c
       JOIN users u ON u.id = c.employee_user_id
       JOIN approval_steps manager_step ON manager_step.claim_id = c.id AND manager_step.role_code = 'manager'
       JOIN approval_steps reviewer_step ON reviewer_step.claim_id = c.id AND reviewer_step.role_code <> 'manager'
       WHERE manager_step.status = 'approved'
         AND c.status NOT IN ('approved', 'force_approved_by_ceo', 'rejected_rule_engine', 'force_rejected_by_ceo')
         AND reviewer_step.status IN ('waiting', 'pending')`
    );

    for (const claim of claims) {
      const [cfoRows] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM approval_steps
         WHERE claim_id = ? AND role_code = 'cfo'`,
        [claim.id]
      );
      if (!Number(cfoRows[0]?.count || 0)) {
        const [approverRows] = await connection.query(
          `SELECT MIN(u.id) AS approver_user_id
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           WHERE r.code = 'cfo' AND u.company_id = ?`,
          [claim.company_id]
        );
        if (approverRows[0]?.approver_user_id) {
          await connection.query(
            `INSERT INTO approval_steps (claim_id, step_order, role_code, approver_user_id, status)
             VALUES (?, 99, 'cfo', ?, 'pending')`,
            [claim.id, approverRows[0].approver_user_id]
          );
        }
      }

      await connection.query(
        `UPDATE approval_steps
         SET status = 'pending'
         WHERE claim_id = ? AND role_code <> 'manager' AND status = 'waiting'`,
        [claim.id]
      );
      await connection.query(
        `UPDATE claims
         SET status = 'under_parallel_review'
         WHERE id = ? AND status NOT IN ('approved', 'force_approved_by_ceo', 'rejected_rule_engine', 'force_rejected_by_ceo')`,
        [claim.id]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function buildApprovalFlow(connection, claimId, managerId, categoryId, companyId) {
  await connection.query(
    `INSERT INTO approval_steps (claim_id, step_order, role_code, approver_user_id, status)
     VALUES (?, 1, 'manager', ?, 'pending')`,
    [claimId, managerId]
  );

  const [flowRows] = await connection.query(
    `SELECT af.step_order, r.code AS role_code, MIN(u.id) AS approver_user_id
     FROM approval_flows af
     JOIN roles r ON r.id = af.role_id
     LEFT JOIN user_roles ur ON ur.role_id = af.role_id
     LEFT JOIN users u ON u.id = ur.user_id
     WHERE af.category_id = ?
       AND u.company_id = ?
     GROUP BY af.step_order, r.code
     ORDER BY af.step_order ASC`,
    [categoryId, companyId]
  );

  for (const row of flowRows) {
    if (!row.approver_user_id) {
      continue;
    }
    await connection.query(
      `INSERT INTO approval_steps (claim_id, step_order, role_code, approver_user_id, status)
       VALUES (?, ?, ?, ?, 'waiting')`,
      [claimId, row.step_order + 1, row.role_code, row.approver_user_id]
    );
  }

  const [cfoRows] = await connection.query(
    `SELECT MIN(u.id) AS approver_user_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'cfo' AND u.company_id = ?`,
    [companyId]
  );
  if (cfoRows[0]?.approver_user_id) {
    await connection.query(
      `INSERT INTO approval_steps (claim_id, step_order, role_code, approver_user_id, status)
       VALUES (?, 99, 'cfo', ?, 'waiting')`,
      [claimId, cfoRows[0].approver_user_id]
    );
  }
}

async function getPendingStepForUser(connection, claimId, userId) {
  const [rows] = await connection.query(
    `SELECT * FROM approval_steps
     WHERE claim_id = ? AND approver_user_id = ? AND status = 'pending'
     ORDER BY step_order ASC, id ASC
     LIMIT 1`,
    [claimId, userId]
  );
  return rows[0] || null;
}

async function analyzeClaimDraft(connection, { employeeId, categoryId, amount, reportedCurrency, description, remarks, expenseDate, receipt }) {
  const employee = await getUserById(employeeId);
  if (!employee?.manager_user_id) {
    throw new Error("Your reporting manager is not configured yet. Ask admin to define the relationship.");
  }

  const category = await getCategoryById(categoryId);
  const companyCurrency = employee.currency_code || "INR";
  const exchangeRate = await getExchangeRate(reportedCurrency, companyCurrency);
  const convertedAmount = Number(amount) * Number(exchangeRate);
  const receiptHash = crypto.createHash("sha256").update(receipt.buffer).digest("hex");
  const ocr = await runReceiptOcr(receipt, amount, expenseDate);

  const [dupRows] = await connection.query(
    "SELECT id, employee_user_id, description FROM claims WHERE receipt_hash = ?",
    [receiptHash]
  );

  const { sharedBillFlag, sharedBillCount } = await detectSharedBill(connection, employeeId, receiptHash, ocr);

  let billRefDuplicateCount = 0;
  if (ocr.billRef) {
    const [billRefRows] = await connection.query(
      `SELECT COUNT(*) AS count
       FROM claims
       WHERE employee_user_id <> ? AND ocr_bill_ref = ? AND ocr_date = ?`,
      [employeeId, ocr.billRef, ocr.date]
    );
    billRefDuplicateCount = Number(billRefRows[0]?.count || 0);
  }

  const [sameEmployeeRows] = await connection.query(
    `SELECT COUNT(*) AS count
     FROM claims
     WHERE employee_user_id = ? AND receipt_hash = ?`,
    [employeeId, receiptHash]
  );

  const normalizedVendor = normalizeVendor(ocr.vendor);
  let patternCount = 0;
  if (normalizedVendor && ocr.date && ocr.amount) {
    const [patternRows] = await connection.query(
      `SELECT ocr_vendor
       FROM claims
       WHERE ocr_date = ? AND ABS(IFNULL(ocr_amount, 0) - ?) <= 1`,
      [ocr.date, Number(ocr.amount)]
    );
    patternCount = patternRows.filter((row) => normalizeVendor(row.ocr_vendor) === normalizedVendor).length;
  }

  const duplicateFlag = dupRows.length > 0 || billRefDuplicateCount > 0;
  const amountMismatchFlag = ["extracted", "partial"].includes(ocr.status)
    ? Math.abs(Number(amount) - Number(ocr.amount || 0)) > 5
    : false;
  const unusualFlag = Number(amount) > Number(category.soft_limit || 0);
  const suspiciousBillFlag = ocr.status === "failed" || (!ocr.billRef && ocr.status !== "extracted") || !ocr.vendor;
  const sameEmployeeDuplicateFlag = sameEmployeeRows[0]?.count > 0;
  const vendorPatternFlag = patternCount > 0;

  let riskScore = 0;
  const reasons = [];
  const warnings = [];

  if (suspiciousBillFlag) {
    riskScore += 20;
    reasons.push("This bill may not be authentic");
    warnings.push({
      code: "suspicious_bill",
      title: "Bill Authenticity Check",
      message: "This bill may not be authentic. Do you still want to proceed?",
      severity: "danger",
    });
  }
  if (amountMismatchFlag) {
    riskScore += 30;
    reasons.push("Entered amount does not match the bill amount");
    warnings.push({
      code: "amount_mismatch",
      title: "Amount Mismatch Check",
      message: "Entered amount does not match the bill amount.",
      severity: "warning",
      suggested_amount: Number(ocr.amount || 0),
    });
  }
  if (duplicateFlag) {
    riskScore += 50;
    reasons.push("This bill has already been submitted");
    warnings.push({
      code: "duplicate_bill",
      title: "Duplicate Bill Check",
      message: "This bill has already been submitted.",
      severity: "danger",
      existing_claims: dupRows.length + billRefDuplicateCount,
    });
  }
  if (sharedBillFlag) {
    riskScore += 40;
    reasons.push(`Possible shared bill detected across ${sharedBillCount} other employee claim${sharedBillCount === 1 ? "" : "s"}`);
    warnings.push({
      code: "shared_bill",
      title: "Shared Bill Check",
      message: `This bill appears to be shared across ${sharedBillCount} other employee claim${sharedBillCount === 1 ? "" : "s"}.`,
      severity: "danger",
    });
  }
  if (sameEmployeeDuplicateFlag) {
    riskScore += 35;
    reasons.push("Same employee submitted an identical bill before");
    warnings.push({
      code: "same_employee_duplicate",
      title: "Similar Check",
      message: "The same employee has already submitted an identical bill before.",
      severity: "warning",
    });
  }
  if (vendorPatternFlag) {
    riskScore += 15;
    reasons.push("Same vendor + same amount + same date pattern detected");
    warnings.push({
      code: "vendor_pattern",
      title: "Similar Pattern Check",
      message: "A same vendor + same amount + same date pattern was found in previous claims.",
      severity: "warning",
    });
  }
  if (unusualFlag) {
    riskScore += 20;
    reasons.push("Unusually high amount compared to typical claims");
    warnings.push({
      code: "threshold_high",
      title: "Threshold Check",
      message: "This amount is unusually high compared to typical claims.",
      severity: "warning",
      threshold: Number(category.soft_limit || 0),
    });
  }

  const anomalyAssessment = await getMlAnomalyAssessment({
    company_id: employee.company_id,
    employee_user_id: employeeId,
    category_id: categoryId,
    converted_amount: convertedAmount,
    expense_date: expenseDate,
    risk_score: riskScore,
    duplicate_flag: duplicateFlag ? 1 : 0,
    shared_bill_flag: sharedBillFlag ? 1 : 0,
    amount_mismatch_flag: amountMismatchFlag ? 1 : 0,
    unusual_flag: unusualFlag ? 1 : 0,
  });

  if (anomalyAssessment.available && anomalyAssessment.is_anomaly) {
    riskScore += 25;
    reasons.push("ML anomaly model flagged the expense");
    warnings.push({
      code: "ml_anomaly",
      title: "AI Fraud Detection",
      message: anomalyAssessment.message,
      severity: "danger",
      anomaly_score: anomalyAssessment.anomaly_score,
    });
  }

  const authenticityStatus = duplicateFlag || sharedBillFlag || amountMismatchFlag || suspiciousBillFlag || (anomalyAssessment.available && anomalyAssessment.is_anomaly)
    ? "suspicious"
    : "authentic";
  const summary = reasons.join(" | ") || "Authentic";
  const formattedRequest = formatRequest({
    categoryName: category.name,
    amount,
    currency: reportedCurrency,
    expenseDate,
    vendor: ocr.vendor,
    description,
    summary,
  });

  return {
    employee,
    category,
    companyCurrency,
    exchangeRate,
    convertedAmount,
    receiptHash,
    ocr,
    duplicateFlag,
    sharedBillFlag,
    sharedBillCount,
    amountMismatchFlag,
    unusualFlag,
    suspiciousBillFlag,
    sameEmployeeDuplicateFlag,
    vendorPatternFlag,
    riskScore,
    summary,
    warnings,
    anomalyAssessment,
    authenticityStatus,
    formattedRequest,
    validationFlags: warnings.map((warning) => warning.code),
  };
}

async function precheckClaim(payload) {
  if (!payload.employeeId || !payload.categoryId || !payload.amount || !payload.expenseDate || !payload.receipt) {
    throw new Error("Required fields are missing for the reimbursement request.");
  }

  const connection = await pool.getConnection();
  try {
    return await analyzeClaimDraft(connection, payload);
  } finally {
    connection.release();
  }
}

async function createClaim({ employeeId, categoryId, amount, reportedCurrency, description, remarks, expenseDate, receipt, submitAnyway = false, employeeJustification = "" }) {
  if (!employeeId || !categoryId || !amount || !expenseDate || !receipt) {
    throw new Error("Required fields are missing for the reimbursement request.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const analysis = await analyzeClaimDraft(connection, { employeeId, categoryId, amount, reportedCurrency, description, remarks, expenseDate, receipt });
    const {
      employee,
      category,
      companyCurrency,
      exchangeRate,
      convertedAmount,
      receiptHash,
      ocr,
      duplicateFlag,
      sharedBillFlag,
      sharedBillCount,
      amountMismatchFlag,
      unusualFlag,
      riskScore,
      summary,
      warnings,
      authenticityStatus,
      formattedRequest,
      validationFlags,
    } = analysis;

    if (warnings.length && !submitAnyway) {
      throw new Error("Validation warnings must be reviewed before submission.");
    }
    if (warnings.length && !String(employeeJustification || "").trim()) {
      throw new Error("Please provide a justification before submitting a flagged reimbursement.");
    }

    const [result] = await connection.query(
      `INSERT INTO claims
        (employee_user_id, manager_user_id, category_id, amount, reported_currency, company_currency, exchange_rate, converted_amount,
         expense_date, description, remarks, receipt_name, receipt_hash, ocr_vendor, ocr_bill_ref, ocr_amount, ocr_date, ocr_status,
         authenticity_status, risk_score, ai_summary, employee_justification, formatted_request, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_manager')`,
      [
        employeeId,
        employee.manager_user_id,
        categoryId,
        amount,
        reportedCurrency,
        companyCurrency,
        exchangeRate,
        convertedAmount,
        expenseDate,
        description,
        remarks || "",
        receipt.originalname,
        receiptHash,
        ocr.vendor,
        ocr.billRef,
        ocr.amount,
        ocr.date,
        ocr.status,
        authenticityStatus,
        riskScore,
        summary,
        employeeJustification || null,
        formattedRequest,
      ]
    );

    const claimId = result.insertId;
    await createValidationFlagRows(connection, claimId, warnings);
    await createFraudFlagRows(connection, claimId, employeeId, warnings, riskScore);
    await createCurrencyLog(connection, claimId, reportedCurrency, companyCurrency, exchangeRate, amount, convertedAmount);
    await createExpenseInsightRows(connection, claimId, employeeId, categoryId, employee.company_id, convertedAmount, companyCurrency);
    await buildApprovalFlow(connection, claimId, employee.manager_user_id, categoryId, employee.company_id);
    await createAiAudit(connection, claimId, {
      receiptHash,
      ocr,
      duplicateFlag,
      sharedBillFlag,
      sharedBillCount,
      amountMismatchFlag,
      unusualFlag,
      riskScore,
      summary,
    });
    await logTimeline(connection, claimId, "Request initiated by employee", employeeId);
    if (warnings.length) {
      await logTimeline(connection, claimId, `Employee submitted despite warnings: ${validationFlags.join(", ")}`, employeeId);
    }
    await createNotification(connection, employee.manager_user_id, claimId, "Approval required", `${employee.full_name} submitted a ${category.name} request.`);
    await createNotification(connection, employeeId, claimId, "Request submitted", `Your reimbursement is pending manager approval.`);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function approveStep(claimId, userId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const current = await getPendingStepForUser(connection, claimId, userId);
    if (!current) {
      throw new Error("No pending approval step found for this reviewer.");
    }

    await connection.query("UPDATE approval_steps SET status = 'approved', acted_at = NOW() WHERE id = ?", [current.id]);
    await logTimeline(connection, claimId, `${current.role_code} approved the request`, userId);

    const [claimRows] = await connection.query("SELECT employee_user_id FROM claims WHERE id = ?", [claimId]);
    const employeeUserId = claimRows[0].employee_user_id;

    if (current.role_code === "manager") {
      const [reviewers] = await connection.query(
        "SELECT id, approver_user_id, role_code FROM approval_steps WHERE claim_id = ? AND role_code <> 'manager' AND status = 'waiting'",
        [claimId]
      );
      for (const reviewer of reviewers) {
        await connection.query("UPDATE approval_steps SET status = 'pending' WHERE id = ?", [reviewer.id]);
        await createNotification(connection, reviewer.approver_user_id, claimId, "Approval required", `A reimbursement request is waiting for your ${reviewer.role_code} review.`);
      }
      await connection.query("UPDATE claims SET status = 'under_parallel_review' WHERE id = ?", [claimId]);
      await createNotification(connection, employeeUserId, claimId, "Status updated", "Manager approved. Sent to Department Head, Finance, Stakeholders, and CFO.");
    } else if (current.role_code === "cfo") {
      await connection.query(
        "UPDATE approval_steps SET status = 'bypassed' WHERE claim_id = ? AND role_code <> 'cfo' AND role_code <> 'manager' AND status IN ('pending','waiting')",
        [claimId]
      );
      await connection.query("UPDATE claims SET status = 'approved' WHERE id = ?", [claimId]);
      await createNotification(connection, employeeUserId, claimId, "Request approved", "CFO approved the request. Expense is immediately approved.");
    } else {
      await evaluateRuleEngine(connection, claimId, employeeUserId);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function rejectStep(claimId, userId, comment) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const current = await getPendingStepForUser(connection, claimId, userId);
    if (!current) {
      throw new Error("No pending approval step found for this reviewer.");
    }
    await connection.query(
      "UPDATE approval_steps SET status = 'rejected', acted_at = NOW(), comment = ? WHERE id = ?",
      [comment || "", current.id]
    );
    const [claimRows] = await connection.query("SELECT employee_user_id FROM claims WHERE id = ?", [claimId]);
    const employeeUserId = claimRows[0].employee_user_id;

    if (current.role_code === "manager") {
      const rejectStatus = getRejectStatus(current.role_code);
      await connection.query("UPDATE claims SET status = ? WHERE id = ?", [rejectStatus, claimId]);
      await connection.query(
        "UPDATE approval_steps SET status = 'bypassed' WHERE claim_id = ? AND role_code <> 'manager' AND status IN ('pending','waiting')",
        [claimId]
      );
      await logTimeline(connection, claimId, "manager disapproved the request", userId);
      await createNotification(connection, employeeUserId, claimId, "Request disapproved", getStatusLabel(rejectStatus));
    } else {
      await logTimeline(connection, claimId, `${current.role_code} disapproved the request`, userId);
      await evaluateRuleEngine(connection, claimId, employeeUserId);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function evaluateRuleEngine(connection, claimId, employeeUserId) {
  const [steps] = await connection.query(
    "SELECT role_code, status, approver_user_id FROM approval_steps WHERE claim_id = ? AND role_code <> 'manager'",
    [claimId]
  );

  const cfoStep = steps.find((step) => step.role_code === "cfo");
  if (cfoStep?.status === "approved") {
    await connection.query("UPDATE claims SET status = 'approved' WHERE id = ?", [claimId]);
    await createNotification(connection, employeeUserId, claimId, "Request approved", "CFO approved the request. Expense is immediately approved.");
    return;
  }

  const consensusSteps = steps.filter((step) => step.role_code !== "cfo");
  const approvedCount = consensusSteps.filter((step) => step.status === "approved").length;
  const decidedCount = consensusSteps.filter((step) => ["approved", "rejected", "bypassed"].includes(step.status)).length;
  const consensusRatio = consensusSteps.length ? approvedCount / consensusSteps.length : 0;

  if (consensusSteps.length && consensusRatio >= 0.6) {
    await connection.query("UPDATE claims SET status = 'approved' WHERE id = ?", [claimId]);
    await connection.query(
      "UPDATE approval_steps SET status = 'bypassed' WHERE claim_id = ? AND role_code <> 'manager' AND status = 'pending'",
      [claimId]
    );
    await createNotification(connection, employeeUserId, claimId, "Request approved", "60% stakeholder consensus was achieved.");
    return;
  }

  const cfoDecided = !cfoStep || ["approved", "rejected", "bypassed"].includes(cfoStep.status);
  if (consensusSteps.length && decidedCount === consensusSteps.length && cfoDecided) {
    await connection.query("UPDATE claims SET status = 'rejected_rule_engine' WHERE id = ?", [claimId]);
    await createNotification(connection, employeeUserId, claimId, "Request rejected", "Consensus did not reach 60% and CFO did not approve.");
    return;
  }

  await connection.query("UPDATE claims SET status = 'under_parallel_review' WHERE id = ?", [claimId]);
}

async function ceoOverride(claimId, userId, decision) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const finalStatus = decision === "approve" ? "force_approved_by_ceo" : "force_rejected_by_ceo";
    const [claimRows] = await connection.query("SELECT employee_user_id FROM claims WHERE id = ?", [claimId]);
    await connection.query("UPDATE claims SET status = ? WHERE id = ?", [finalStatus, claimId]);
    await logTimeline(connection, claimId, `CEO override: ${decision}`, userId);
    await createNotification(connection, claimRows[0].employee_user_id, claimId, "CEO override", getStatusLabel(finalStatus));
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createUserByAdmin({ companyId, fullName, email, password, roleCode, departmentId, managerUserId }) {
  if (!fullName || !email || !password || !roleCode) {
    throw new Error("Name, email, password, and role are required.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO users (full_name, email, password, company_id, department_id, manager_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fullName, email, password, companyId, departmentId || null, managerUserId || null]
    );
    const [roleRows] = await connection.query("SELECT id FROM roles WHERE code = ? LIMIT 1", [roleCode]);
    await connection.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [result.insertId, roleRows[0].id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("A user with this email already exists.");
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function saveApprovalFlow({ categoryId, roleCodes }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM approval_flows WHERE category_id = ?", [categoryId]);
    let step = 1;
    for (const roleCode of roleCodes.filter(Boolean)) {
      const [rows] = await connection.query("SELECT id FROM roles WHERE code = ? LIMIT 1", [roleCode]);
      if (!rows[0]) {
        continue;
      }
      await connection.query(
        "INSERT INTO approval_flows (category_id, step_order, role_id) VALUES (?, ?, ?)",
        [categoryId, step, rows[0].id]
      );
      step += 1;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getOverviewStats(companyId = 1) {
  const [rows] = await pool.query(
    `SELECT
      COUNT(*) AS total_claims,
      SUM(CASE WHEN status IN ('approved', 'force_approved_by_ceo') THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN status LIKE 'disapproved%' OR status IN ('rejected_rule_engine', 'force_rejected_by_ceo') THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status LIKE 'under_review%' OR status IN ('pending_manager', 'under_parallel_review') THEN 1 ELSE 0 END) AS pending_count,
      ROUND(IFNULL(SUM(converted_amount), 0), 2) AS total_spend
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     WHERE u.company_id = ?`,
    [companyId]
  );

  const [departmentRows] = await pool.query(
    `SELECT d.name, ROUND(IFNULL(SUM(c.converted_amount), 0), 2) AS total
     FROM departments d
     LEFT JOIN users u ON u.department_id = d.id
     LEFT JOIN claims c ON c.employee_user_id = u.id
     WHERE u.company_id = ? OR u.company_id IS NULL
     GROUP BY d.id, d.name
     ORDER BY total DESC`,
    [companyId]
  );

  return {
    summary: rows[0] || { total_claims: 0, approved_count: 0, rejected_count: 0, pending_count: 0, total_spend: 0 },
    departmentSpend: departmentRows,
  };
}

async function getClaimsForEmployee(userId) {
  const [rows] = await pool.query(
    `SELECT c.*, ec.name AS category_name
     FROM claims c
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE c.employee_user_id = ?
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map((row) => ({ ...row, status_label: getStatusLabel(row.status) }));
}

async function getEmployeeTimeline(userId) {
  const [rows] = await pool.query(
    `SELECT c.id AS claim_id, c.description, c.amount, c.status, t.event_label, t.created_at
     FROM claims c
     LEFT JOIN timelines t ON t.claim_id = c.id
     WHERE c.employee_user_id = ?
     ORDER BY t.created_at DESC, c.id DESC`,
    [userId]
  );
  return rows;
}

async function getManagerQueue(userId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.amount, c.reported_currency, c.expense_date, c.status, c.ai_summary, c.converted_amount, c.company_currency, c.description,
            u.full_name AS employee_name, d.name AS department_name, ec.name AS category_name
     FROM claims c
     JOIN approval_steps aps ON aps.claim_id = c.id
     JOIN users u ON u.id = c.employee_user_id
     LEFT JOIN departments d ON d.id = u.department_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE aps.approver_user_id = ? AND aps.status = 'pending'
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map((row) => ({ ...row, status_label: getStatusLabel(row.status) }));
}

async function getManagerTeam(userId) {
  const [rows] = await pool.query(
    `SELECT u.full_name, u.email, d.name AS department_name
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.manager_user_id = ?
     ORDER BY u.full_name`,
    [userId]
  );
  return rows;
}

async function getFinanceQueue(companyId = 1) {
  const [rows] = await pool.query(
    `SELECT c.id, c.amount, c.reported_currency, c.expense_date, c.status, c.risk_score, c.ai_summary, c.converted_amount, c.company_currency,
            u.full_name AS employee_name, ec.name AS category_name, d.name AS department_name
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     LEFT JOIN departments d ON d.id = u.department_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE u.company_id = ?
     ORDER BY c.created_at DESC
     LIMIT 20`,
    [companyId]
  );
  return rows.map((row) => ({ ...row, status_label: getStatusLabel(row.status) }));
}

async function getReviewerQueue(userId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.amount, c.reported_currency, c.expense_date, c.status, c.risk_score, c.ai_summary, c.converted_amount, c.company_currency,
            u.full_name AS employee_name, ec.name AS category_name, d.name AS department_name, aps.role_code
     FROM claims c
     JOIN approval_steps aps ON aps.claim_id = c.id
     JOIN users u ON u.id = c.employee_user_id
     LEFT JOIN departments d ON d.id = u.department_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE aps.approver_user_id = ? AND aps.status = 'pending'
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows.map((row) => ({ ...row, status_label: getStatusLabel(row.status) }));
}

async function getCeoQueue(companyId = 1) {
  const [rows] = await pool.query(
    `SELECT c.id, c.amount, c.reported_currency, c.company_currency, c.converted_amount, c.status, c.ai_summary,
            u.full_name AS employee_name, ec.name AS category_name
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE u.company_id = ? AND c.status IN ('under_parallel_review', 'approved', 'rejected_rule_engine')
     ORDER BY c.created_at DESC`,
    [companyId]
  );
  return rows.map((row) => ({ ...row, status_label: getStatusLabel(row.status) }));
}

async function getExecutiveSummary(companyId = 1) {
  const stats = await getOverviewStats(companyId);
  const [topFlags] = await pool.query(
    `SELECT u.full_name AS employee_name, c.description, c.converted_amount, c.company_currency, c.risk_score, c.ai_summary
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     WHERE u.company_id = ? AND c.risk_score > 0
     ORDER BY c.risk_score DESC, c.created_at DESC
     LIMIT 5`,
    [companyId]
  );
  return { ...stats, topFlags };
}

async function getAdminConfigData(companyId = 1) {
  const [users] = await pool.query(
    `SELECT u.id, u.full_name, u.email, COALESCE(r.name, 'Unassigned') AS role_name, r.code AS role_code,
            d.name AS department_name, manager.full_name AS manager_name
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN users manager ON manager.id = u.manager_user_id
     WHERE u.company_id = ?
     ORDER BY u.id ASC`,
    [companyId]
  );

  const [flows] = await pool.query(
    `SELECT ec.id AS category_id, ec.name AS category_name, ec.soft_limit, af.step_order, r.name AS role_name, r.code AS role_code
     FROM approval_flows af
     JOIN expense_categories ec ON ec.id = af.category_id
     JOIN roles r ON r.id = af.role_id
     ORDER BY ec.name ASC, af.step_order ASC`
  );

  return { users, flows };
}

async function getNotifications(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 8`,
    [userId]
  );
  return rows;
}

async function getCategories() {
  const [rows] = await pool.query("SELECT * FROM expense_categories ORDER BY name");
  return rows;
}

async function getRolesForAdmin() {
  const [rows] = await pool.query(
    `SELECT code, name
     FROM roles
     WHERE code IN ('admin', 'employee', 'manager', 'finance', 'cfo', 'ceo', 'department_head', 'ops', 'tech_head', 'procurement', 'marketing_head', 'senior_manager')
     ORDER BY name`
  );
  return rows;
}

async function getDepartments() {
  const [rows] = await pool.query("SELECT * FROM departments ORDER BY name");
  return rows;
}

async function getUsersByRole(roleCode, companyId = null) {
  const sql = companyId
    ? `SELECT u.id, u.full_name
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE r.code = ? AND u.company_id = ?
       ORDER BY u.full_name`
    : `SELECT u.id, u.full_name
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE r.code = ?
       ORDER BY u.full_name`;
  const [rows] = await pool.query(sql, companyId ? [roleCode, companyId] : [roleCode]);
  return rows;
}

async function getHistoryFeed(userId, roleCode, companyId = 1) {
  if (roleCode === "employee") {
    const [rows] = await pool.query(
      `SELECT c.id AS claim_id, c.description, c.status, t.event_label, t.created_at
       FROM claims c
       JOIN timelines t ON t.claim_id = c.id
       WHERE c.employee_user_id = ?
       ORDER BY t.created_at DESC
       LIMIT 12`,
      [userId]
    );
    return rows.map((row) => ({
      ...row,
      title: row.description || `Claim #${row.claim_id}`,
      detail: row.event_label,
      status_label: getStatusLabel(row.status),
      created_at: row.created_at,
    }));
  }

  if (["manager", "finance", "cfo", "department_head", "ops", "procurement", "tech_head", "marketing_head", "senior_manager"].includes(roleCode)) {
    const [rows] = await pool.query(
      `SELECT c.id AS claim_id, c.status, aps.role_code, aps.status AS review_status, aps.acted_at, c.created_at,
              u.full_name AS employee_name, ec.name AS category_name
       FROM approval_steps aps
       JOIN claims c ON c.id = aps.claim_id
       JOIN users u ON u.id = c.employee_user_id
       JOIN expense_categories ec ON ec.id = c.category_id
       WHERE aps.approver_user_id = ? AND (aps.acted_at IS NOT NULL OR aps.status = 'pending')
       ORDER BY COALESCE(aps.acted_at, c.created_at) DESC
       LIMIT 12`,
      [userId]
    );
    return rows.map((row) => ({
      ...row,
      title: `${row.employee_name} · ${row.category_name}`,
      detail: row.review_status === "pending" ? "Awaiting your decision" : `You ${row.review_status} this request`,
      status_label: getStatusLabel(row.status),
      created_at: row.acted_at || row.created_at,
    }));
  }

  const [rows] = await pool.query(
    `SELECT c.id AS claim_id, c.status, t.event_label, t.created_at, u.full_name AS employee_name, ec.name AS category_name
     FROM timelines t
     JOIN claims c ON c.id = t.claim_id
     JOIN users u ON u.id = c.employee_user_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE u.company_id = ?
     ORDER BY t.created_at DESC
     LIMIT 12`,
    [companyId]
  );
  return rows.map((row) => ({
    ...row,
    title: `${row.employee_name} · ${row.category_name}`,
    detail: row.event_label,
    status_label: getStatusLabel(row.status),
    created_at: row.created_at,
  }));
}

module.exports = {
  getCountryCurrencyRows,
  STATUS_LABELS,
  initDatabase,
  inferCurrencyFromCountry,
  createCompanySetup,
  authenticateUser,
  getUserById,
  getRoleRedirect,
  getRoleLabel,
  getStatusLabel,
  precheckClaim,
  createClaim,
  approveStep,
  rejectStep,
  createUserByAdmin,
  saveApprovalFlow,
  getOverviewStats,
  getClaimsForEmployee,
  getEmployeeTimeline,
  getManagerQueue,
  getManagerTeam,
  getFinanceQueue,
  getReviewerQueue,
  getCeoQueue,
  getExecutiveSummary,
  getAdminConfigData,
  getNotifications,
  getCategories,
  getRolesForAdmin,
  getDepartments,
  getUsersByRole,
  getHistoryFeed,
  ceoOverride,
};
