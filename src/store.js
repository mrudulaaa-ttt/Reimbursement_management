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
      await pool.query(
        "ALTER TABLE users ADD CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies(id)"
      );
    } catch (error) {
      if (error.code !== "ER_DUP_KEYNAME" && error.code !== "ER_CANT_CREATE_TABLE") {
        throw error;
      }
    }
  }
}

function inferCurrencyFromCountry(country) {
  const normalized = String(country || "").trim().toLowerCase();
  const map = {
    india: "INR",
    "united states": "USD",
    usa: "USD",
    uk: "GBP",
    "united kingdom": "GBP",
    germany: "EUR",
    france: "EUR",
    singapore: "SGD",
    uae: "AED",
  };
  return map[normalized] || "USD";
}

function fakeOcr(receipt, amount, expenseDate) {
  const fileName = receipt?.originalname || "receipt.jpg";
  return {
    vendor: fileName.replace(path.extname(fileName), "").replace(/[_-]/g, " "),
    amount,
    date: expenseDate,
  };
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

async function getCategoryThreshold(categoryId) {
  const [rows] = await pool.query("SELECT soft_limit FROM expense_categories WHERE id = ?", [categoryId]);
  return rows[0]?.soft_limit || 0;
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

async function logTimeline(connection, claimId, label, actorUserId = null) {
  await connection.query("INSERT INTO timelines (claim_id, actor_user_id, event_label) VALUES (?, ?, ?)", [
    claimId,
    actorUserId,
    label,
  ]);
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
      [company_name + " Admin", email, password, companyId]
    );

    const [roleRows] = await connection.query("SELECT id FROM roles WHERE code = 'admin' LIMIT 1");
    if (roleRows[0]?.id) {
      await connection.query("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [
        userResult.insertId,
        roleRows[0].id,
      ]);
    }
    await connection.commit();
    return { companyId, currency };
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

async function authenticateUser(email, password) {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.company_id, c.name AS company_name, c.currency_code
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.email = ? AND u.password = ?
     LIMIT 1`,
    [email, password]
  );

  if (!rows[0]) {
    return null;
  }

  const user = rows[0];
  const role = await getPrimaryRole(user.id);
  return { ...user, role_code: role.code, role_name: role.name };
}

async function getPrimaryRole(userId) {
  const [rows] = await pool.query(
    `SELECT r.code, r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ?
     ORDER BY FIELD(r.code, 'admin', 'employee', 'manager', 'finance', 'cfo', 'department_head', 'ops', 'tech_head', 'procurement', 'marketing_head')
     LIMIT 1`,
    [userId]
  );
  return rows[0] || { code: "employee", name: "Employee" };
}

async function getUserById(userId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.company_id, c.name AS company_name, c.currency_code
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

async function createClaim({ employeeId, managerId, categoryId, amount, description, expenseDate, receipt }) {
  if (!employeeId || !managerId || !categoryId || !amount || !expenseDate || !receipt) {
    throw new Error("Employee, manager, category, amount, date, and receipt are required.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const receiptHash = crypto.createHash("sha256").update(receipt.buffer).digest("hex");
    const ocr = fakeOcr(receipt, amount, expenseDate);
    const [dupRows] = await connection.query("SELECT id FROM claims WHERE receipt_hash = ? LIMIT 1", [receiptHash]);

    const threshold = await getCategoryThreshold(categoryId);
    const duplicateFlag = dupRows.length > 0;
    const amountMismatchFlag = Math.abs(Number(amount) - Number(ocr.amount)) > 5;
    const unusualFlag = threshold > 0 && Number(amount) > Number(threshold);

    let riskScore = 0;
    const reasons = [];
    if (duplicateFlag) {
      riskScore += 50;
      reasons.push("AI: Duplicate detected");
    }
    if (amountMismatchFlag) {
      riskScore += 30;
      reasons.push("Amount mismatch");
    }
    if (unusualFlag) {
      riskScore += 20;
      reasons.push("Unusually high");
    }

    const status = "pending_manager";
    const summary = reasons.join(" | ") || "Authentic";

    const [result] = await connection.query(
      `INSERT INTO claims
        (employee_user_id, manager_user_id, category_id, amount, expense_date, description, receipt_name, receipt_hash,
         ocr_vendor, ocr_amount, ocr_date, risk_score, ai_summary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeId,
        managerId,
        categoryId,
        amount,
        expenseDate,
        description || "",
        receipt.originalname,
        receiptHash,
        ocr.vendor,
        ocr.amount,
        ocr.date,
        riskScore,
        summary,
        status,
      ]
    );

    const claimId = result.insertId;
    await buildApprovalFlow(connection, claimId, managerId, categoryId);
    await createAiAudit(connection, claimId, {
      receiptHash,
      ocr,
      duplicateFlag,
      amountMismatchFlag,
      unusualFlag,
      riskScore,
      summary,
    });
    await logTimeline(connection, claimId, "Claim submitted", employeeId);
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

    await connection.query("UPDATE approval_steps SET status = 'approved', acted_at = NOW() WHERE id = ?", [
      current.id,
    ]);
    await logTimeline(connection, claimId, `${current.role_code} approved`, userId);

    const nextStep = await getNextWaitingStep(connection, claimId);
    if (nextStep) {
      await connection.query("UPDATE approval_steps SET status = 'pending' WHERE id = ?", [nextStep.id]);
      await connection.query("UPDATE claims SET status = ? WHERE id = ?", [
        nextStep.role_code === "finance" ? "under_finance_review" : "in_review",
        claimId,
      ]);
    } else {
      await connection.query("UPDATE claims SET status = 'approved' WHERE id = ?", [claimId]);
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
    await connection.query("UPDATE claims SET status = 'rejected' WHERE id = ?", [claimId]);
    await logTimeline(connection, claimId, `${current.role_code} rejected${comment ? `: ${comment}` : ""}`, userId);
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
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status IN ('pending_manager', 'in_review', 'under_finance_review') THEN 1 ELSE 0 END) AS pending_count,
      ROUND(IFNULL(SUM(amount), 0), 2) AS total_spend
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     WHERE u.company_id = ?`,
    [companyId]
  );

  const [departmentRows] = await pool.query(
    `SELECT d.name, ROUND(IFNULL(SUM(c.amount), 0), 2) AS total
     FROM departments d
     LEFT JOIN users u ON u.department_id = d.id
     LEFT JOIN claims c ON c.employee_user_id = u.id
     WHERE u.company_id = ? OR u.company_id IS NULL
     GROUP BY d.id, d.name
     ORDER BY total DESC`,
    [companyId]
  );

  return {
    summary: rows[0] || {
      total_claims: 0,
      approved_count: 0,
      rejected_count: 0,
      pending_count: 0,
      total_spend: 0,
    },
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
  return rows;
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
    `SELECT c.id, c.amount, c.expense_date, c.status, c.ai_summary, c.description, u.full_name AS employee_name, d.name AS department_name, ec.name AS category_name
     FROM claims c
     JOIN approval_steps aps ON aps.claim_id = c.id
     JOIN users u ON u.id = c.employee_user_id
     LEFT JOIN departments d ON d.id = u.department_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE aps.approver_user_id = ? AND aps.status = 'pending'
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows;
}

async function getFinanceQueue(companyId = 1) {
  const [rows] = await pool.query(
    `SELECT c.id, c.amount, c.expense_date, c.status, c.risk_score, c.ai_summary, u.full_name AS employee_name,
            ec.name AS category_name, d.name AS department_name
     FROM claims c
     JOIN users u ON u.id = c.employee_user_id
     LEFT JOIN departments d ON d.id = u.department_id
     JOIN expense_categories ec ON ec.id = c.category_id
     WHERE u.company_id = ?
     ORDER BY c.created_at DESC
     LIMIT 12`,
    [companyId]
  );
  return rows;
}

async function getExecutiveSummary(companyId = 1) {
  const stats = await getOverviewStats(companyId);
  const [topFlags] = await pool.query(
    `SELECT u.full_name AS employee_name, c.description, c.amount, c.risk_score, c.ai_summary
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
    `SELECT u.id, u.full_name, u.email, COALESCE(r.name, 'Unassigned') AS role_name, d.name AS department_name
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.company_id = ?
     ORDER BY u.id ASC`,
    [companyId]
  );

  const [flows] = await pool.query(
    `SELECT ec.name AS category_name, af.step_order, r.name AS role_name
     FROM approval_flows af
     JOIN expense_categories ec ON ec.id = af.category_id
     JOIN roles r ON r.id = af.role_id
     ORDER BY ec.name ASC, af.step_order ASC`
  );

  return { users, flows };
}

async function getCategories() {
  const [rows] = await pool.query("SELECT * FROM expense_categories ORDER BY name");
  return rows;
}

async function getUsersByRole(roleCode) {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = ?
     ORDER BY u.full_name`,
    [roleCode]
  );
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
  initDatabase,
  createCompanySetup,
  authenticateUser,
  getUserById,
  getRoleRedirect,
  getRoleLabel,
  createClaim,
  approveStep,
  rejectStep,
  getOverviewStats,
  getClaimsForEmployee,
  getEmployeeTimeline,
  getManagerQueue,
  getFinanceQueue,
  getExecutiveSummary,
  getAdminConfigData,
  getCategories,
  getUsersByRole,
  getQuickSwitchUsers,
};
