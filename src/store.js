const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pool } = require("./db");

const ROLE_REDIRECTS = {
  admin: "/dashboard/admin",
  employee: "/dashboard/employee",
  manager: "/dashboard/manager",
  finance: "/dashboard/finance",
  cfo: "/dashboard/cfo",
};

const COUNTRY_CURRENCY_MAP = {
  India: "INR",
  "United States": "USD",
  USA: "USD",
  Germany: "EUR",
  France: "EUR",
  "United Kingdom": "GBP",
  UK: "GBP",
  Singapore: "SGD",
  UAE: "AED",
};

const STATUS_LABELS = {
  pending_manager: "Pending Manager Approval",
  under_review_finance: "Under Review of Finance Dept",
  under_review_ops: "Under Review of Operations",
  under_review_department_head: "Under Review of Department Head",
  under_review_procurement: "Under Review of Procurement",
  under_review_marketing_head: "Under Review of Marketing Head",
  under_review_tech_head: "Under Review of Tech Dept Head",
  approved: "Approved",
  disapproved_by_manager: "Disapproved by Manager",
  disapproved_by_finance: "Disapproved by Finance Dept",
  disapproved_by_ops: "Disapproved by Operations",
  disapproved_by_department_head: "Disapproved by Department Head",
  disapproved_by_procurement: "Disapproved by Procurement",
  disapproved_by_marketing_head: "Disapproved by Marketing Head",
  disapproved_by_tech_head: "Disapproved by Tech Dept Head",
};

async function initDatabase() {
  const schema = await fs.readFile(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");
  await pool.query(schema);
  await runMigrations();
  const seed = await fs.readFile(path.join(__dirname, "..", "sql", "seed.sql"), "utf8");
  await pool.query(seed);
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
    ["ocr_status", "VARCHAR(40) NOT NULL DEFAULT 'checked' AFTER ocr_date"],
    ["authenticity_status", "VARCHAR(40) NOT NULL DEFAULT 'authentic' AFTER ocr_status"],
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
}

function inferCurrencyFromCountry(country) {
  return COUNTRY_CURRENCY_MAP[country] || "USD";
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

function fakeOcr(receipt, amount, expenseDate) {
  const fileName = receipt?.originalname || "receipt.jpg";
  return {
    vendor: fileName.replace(path.extname(fileName), "").replace(/[_-]/g, " "),
    amount,
    date: expenseDate,
  };
}

async function getExchangeRate(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
    return 1;
  }
  try {
    const response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(fromCurrency)}`);
    const data = await response.json();
    if (data?.rates?.[toCurrency]) {
      return Number(data.rates[toCurrency]);
    }
  } catch (error) {
    console.warn("Exchange rate API fallback", error.message);
  }
  return 1;
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
    `SELECT u.id, u.full_name, u.email, u.company_id, u.department_id, u.manager_user_id, c.name AS company_name, c.currency_code
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
      (claim_id, receipt_hash, ocr_vendor, ocr_amount, ocr_date, duplicate_flag, amount_mismatch_flag, unusual_flag, risk_score, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      payload.receiptHash,
      payload.ocr.vendor,
      payload.ocr.amount,
      payload.ocr.date,
      payload.duplicateFlag ? 1 : 0,
      payload.amountMismatchFlag ? 1 : 0,
      payload.unusualFlag ? 1 : 0,
      payload.riskScore,
      payload.summary,
    ]
  );
}

async function createCompanySetup({ company_name, country, email, password }) {
  if (!company_name || !country || !email || !password) {
    throw new Error("All signup fields are required.");
  }

  const currency = inferCurrencyFromCountry(country);
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

async function buildApprovalFlow(connection, claimId, managerId, categoryId) {
  await connection.query(
    `INSERT INTO approval_steps (claim_id, step_order, role_code, approver_user_id, status)
     VALUES (?, 1, 'manager', ?, 'pending')`,
    [claimId, managerId]
  );

  const [flowRows] = await connection.query(
    `SELECT af.step_order, r.code AS role_code, MIN(ur.user_id) AS approver_user_id
     FROM approval_flows af
     JOIN roles r ON r.id = af.role_id
     LEFT JOIN user_roles ur ON ur.role_id = af.role_id
     WHERE af.category_id = ?
     GROUP BY af.step_order, r.code
     ORDER BY af.step_order ASC`,
    [categoryId]
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
}

async function getCurrentStep(connection, claimId) {
  const [rows] = await connection.query(
    `SELECT * FROM approval_steps
     WHERE claim_id = ? AND status = 'pending'
     ORDER BY step_order ASC
     LIMIT 1`,
    [claimId]
  );
  return rows[0] || null;
}

async function getNextWaitingStep(connection, claimId) {
  const [rows] = await connection.query(
    `SELECT * FROM approval_steps
     WHERE claim_id = ? AND status = 'waiting'
     ORDER BY step_order ASC
     LIMIT 1`,
    [claimId]
  );
  return rows[0] || null;
}

async function createClaim({ employeeId, categoryId, amount, reportedCurrency, description, remarks, expenseDate, receipt }) {
  if (!employeeId || !categoryId || !amount || !expenseDate || !receipt) {
    throw new Error("Required fields are missing for the reimbursement request.");
  }

  const employee = await getUserById(employeeId);
  if (!employee?.manager_user_id) {
    throw new Error("Your reporting manager is not configured yet. Ask admin to define the relationship.");
  }
  const category = await getCategoryById(categoryId);
  const companyCurrency = employee.currency_code || "INR";
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const exchangeRate = await getExchangeRate(reportedCurrency, companyCurrency);
    const convertedAmount = Number(amount) * Number(exchangeRate);
    const receiptHash = crypto.createHash("sha256").update(receipt.buffer).digest("hex");
    const ocr = fakeOcr(receipt, amount, expenseDate);
    const [dupRows] = await connection.query("SELECT id FROM claims WHERE receipt_hash = ? LIMIT 1", [receiptHash]);

    const duplicateFlag = dupRows.length > 0;
    const amountMismatchFlag = Math.abs(Number(amount) - Number(ocr.amount)) > 5;
    const unusualFlag = Number(amount) > Number(category.soft_limit || 0);
    let riskScore = 0;
    const reasons = [];
    if (duplicateFlag) {
      riskScore += 50;
      reasons.push("Duplicate receipt detected");
    }
    if (amountMismatchFlag) {
      riskScore += 30;
      reasons.push("Reported value differs from OCR value");
    }
    if (unusualFlag) {
      riskScore += 20;
      reasons.push("Threshold suggestor marked the claim as unusually high");
    }

    const authenticityStatus = duplicateFlag || amountMismatchFlag ? "suspicious" : "authentic";
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

    const [result] = await connection.query(
      `INSERT INTO claims
        (employee_user_id, manager_user_id, category_id, amount, reported_currency, company_currency, exchange_rate, converted_amount,
         expense_date, description, remarks, receipt_name, receipt_hash, ocr_vendor, ocr_amount, ocr_date, ocr_status,
         authenticity_status, risk_score, ai_summary, formatted_request, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_manager')`,
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
        ocr.amount,
        ocr.date,
        "checked",
        authenticityStatus,
        riskScore,
        summary,
        formattedRequest,
      ]
    );

    const claimId = result.insertId;
    await buildApprovalFlow(connection, claimId, employee.manager_user_id, categoryId);
    await createAiAudit(connection, claimId, {
      receiptHash,
      ocr,
      duplicateFlag,
      amountMismatchFlag,
      unusualFlag,
      riskScore,
      summary,
    });
    await logTimeline(connection, claimId, "Request initiated by employee", employeeId);
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
    const current = await getCurrentStep(connection, claimId);
    if (!current) {
      throw new Error("No pending approval step found.");
    }
    if (current.approver_user_id !== userId) {
      throw new Error("This user cannot approve the current step.");
    }

    await connection.query("UPDATE approval_steps SET status = 'approved', acted_at = NOW() WHERE id = ?", [current.id]);
    await logTimeline(connection, claimId, `${current.role_code} approved the request`, userId);

    const [claimRows] = await connection.query("SELECT employee_user_id FROM claims WHERE id = ?", [claimId]);
    const employeeUserId = claimRows[0].employee_user_id;
    const nextStep = await getNextWaitingStep(connection, claimId);

    if (nextStep) {
      await connection.query("UPDATE approval_steps SET status = 'pending' WHERE id = ?", [nextStep.id]);
      const newStatus = getReviewStatus(nextStep.role_code);
      await connection.query("UPDATE claims SET status = ? WHERE id = ?", [newStatus, claimId]);
      await createNotification(connection, nextStep.approver_user_id, claimId, "Approval required", `A reimbursement request is waiting for your review.`);
      await createNotification(connection, employeeUserId, claimId, "Status updated", getStatusLabel(newStatus));
    } else {
      await connection.query("UPDATE claims SET status = 'approved' WHERE id = ?", [claimId]);
      await createNotification(connection, employeeUserId, claimId, "Request approved", "Your reimbursement has been fully approved.");
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
    const current = await getCurrentStep(connection, claimId);
    if (!current) {
      throw new Error("No pending approval step found.");
    }
    if (current.approver_user_id !== userId) {
      throw new Error("This user cannot reject the current step.");
    }
    await connection.query(
      "UPDATE approval_steps SET status = 'rejected', acted_at = NOW(), comment = ? WHERE id = ?",
      [comment || "", current.id]
    );
    const rejectStatus = getRejectStatus(current.role_code);
    await connection.query("UPDATE claims SET status = ? WHERE id = ?", [rejectStatus, claimId]);
    await logTimeline(connection, claimId, `${current.role_code} disapproved the request`, userId);

    const [claimRows] = await connection.query("SELECT employee_user_id FROM claims WHERE id = ?", [claimId]);
    await createNotification(connection, claimRows[0].employee_user_id, claimId, "Request disapproved", getStatusLabel(rejectStatus));
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
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN status LIKE 'disapproved%' THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status LIKE 'under_review%' OR status = 'pending_manager' THEN 1 ELSE 0 END) AS pending_count,
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
    `SELECT ec.id AS category_id, ec.name AS category_name, af.step_order, r.name AS role_name, r.code AS role_code
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
     WHERE code IN ('admin', 'employee', 'manager', 'finance', 'cfo', 'department_head', 'ops', 'tech_head', 'procurement', 'marketing_head', 'senior_manager')
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

async function getQuickSwitchUsers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, r.code AS role_code
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email IN ('employee@test.com', 'manager@test.com', 'admin@test.com', 'finance@test.com', 'cfo@test.com')
     ORDER BY FIELD(r.code, 'admin', 'employee', 'manager', 'finance', 'cfo')`
  );
  return rows;
}

module.exports = {
  COUNTRY_CURRENCY_MAP,
  STATUS_LABELS,
  initDatabase,
  inferCurrencyFromCountry,
  createCompanySetup,
  authenticateUser,
  getUserById,
  getRoleRedirect,
  getRoleLabel,
  getStatusLabel,
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
  getExecutiveSummary,
  getAdminConfigData,
  getNotifications,
  getCategories,
  getRolesForAdmin,
  getDepartments,
  getUsersByRole,
  getQuickSwitchUsers,
};
