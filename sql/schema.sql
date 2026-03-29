CREATE TABLE IF NOT EXISTS companies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL UNIQUE,
  country VARCHAR(80) NOT NULL,
  currency_code VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS departments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password VARCHAR(160) NOT NULL DEFAULT 'demo123',
  company_id INT NULL,
  department_id INT NULL,
  manager_user_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_users_manager FOREIGN KEY (manager_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  UNIQUE KEY uniq_user_role (user_id, role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  soft_limit DECIMAL(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approval_flows (
  id INT PRIMARY KEY AUTO_INCREMENT,
  category_id INT NOT NULL,
  step_order INT NOT NULL,
  role_id INT NOT NULL,
  CONSTRAINT fk_approval_flows_category FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_flows_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claims (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employee_user_id INT NOT NULL,
  manager_user_id INT NOT NULL,
  category_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reported_currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  company_currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  exchange_rate DECIMAL(12,6) NOT NULL DEFAULT 1,
  converted_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  expense_date DATE NOT NULL,
  description TEXT,
  remarks TEXT NULL,
  receipt_name VARCHAR(255) NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  ocr_vendor VARCHAR(255),
  ocr_bill_ref VARCHAR(120),
  ocr_amount DECIMAL(12,2),
  ocr_date DATE,
  ocr_status VARCHAR(40) NOT NULL DEFAULT 'checked',
  authenticity_status VARCHAR(40) NOT NULL DEFAULT 'authentic',
  risk_score INT NOT NULL DEFAULT 0,
  ai_summary TEXT,
  employee_justification TEXT NULL,
  formatted_request TEXT,
  status VARCHAR(60) NOT NULL DEFAULT 'pending_manager',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_claims_employee FOREIGN KEY (employee_user_id) REFERENCES users(id),
  CONSTRAINT fk_claims_manager FOREIGN KEY (manager_user_id) REFERENCES users(id),
  CONSTRAINT fk_claims_category FOREIGN KEY (category_id) REFERENCES expense_categories(id)
);

CREATE TABLE IF NOT EXISTS approval_steps (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  step_order INT NOT NULL,
  role_code VARCHAR(50) NOT NULL,
  approver_user_id INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'waiting',
  comment TEXT NULL,
  acted_at TIMESTAMP NULL,
  CONSTRAINT fk_approval_steps_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_steps_user FOREIGN KEY (approver_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS timelines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  actor_user_id INT NULL,
  event_label VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timelines_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
  CONSTRAINT fk_timelines_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  claim_id INT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_audits (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  ocr_vendor VARCHAR(255),
  ocr_bill_ref VARCHAR(120),
  ocr_amount DECIMAL(12,2),
  ocr_date DATE,
  duplicate_flag TINYINT(1) NOT NULL DEFAULT 0,
  shared_bill_flag TINYINT(1) NOT NULL DEFAULT 0,
  shared_bill_count INT NOT NULL DEFAULT 0,
  amount_mismatch_flag TINYINT(1) NOT NULL DEFAULT 0,
  unusual_flag TINYINT(1) NOT NULL DEFAULT 0,
  risk_score INT NOT NULL DEFAULT 0,
  summary TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_audits_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claim_validation_flags (
  id INT PRIMARY KEY AUTO_INCREMENT,
  claim_id INT NOT NULL,
  flag_code VARCHAR(80) NOT NULL,
  flag_title VARCHAR(160) NOT NULL,
  flag_message TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_claim_validation_flags_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fraud_flags (
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
);

CREATE TABLE IF NOT EXISTS currency_logs (
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
);

CREATE TABLE IF NOT EXISTS expense_insights (
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
);
