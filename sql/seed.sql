INSERT IGNORE INTO departments (id, name) VALUES
  (1, 'Engineering'),
  (2, 'Marketing'),
  (3, 'Operations'),
  (4, 'Finance');

INSERT IGNORE INTO roles (id, name, code) VALUES
  (10, 'Admin', 'admin'),
  (1, 'Employee', 'employee'),
  (2, 'Manager', 'manager'),
  (3, 'Department Head', 'department_head'),
  (4, 'Finance', 'finance'),
  (5, 'CFO', 'cfo'),
  (6, 'Ops', 'ops'),
  (7, 'Tech Head', 'tech_head'),
  (8, 'Procurement', 'procurement'),
  (9, 'Marketing Head', 'marketing_head');

INSERT IGNORE INTO companies (id, name, country, currency_code) VALUES
  (1, 'Demo Workspace', 'India', 'INR');

INSERT IGNORE INTO users (id, full_name, email, password, company_id, department_id, manager_user_id) VALUES
  (1, 'Asha Employee', 'employee@test.com', 'demo123', 1, 1, 2),
  (2, 'Ravi Manager', 'manager@test.com', 'demo123', 1, 1, NULL),
  (3, 'Nina Finance', 'finance@test.com', 'demo123', 1, 4, NULL),
  (4, 'Omar Ops', 'ops@test.com', 'demo123', 1, 3, NULL),
  (5, 'Priya Tech Head', 'techhead@test.com', 'demo123', 1, 1, NULL),
  (6, 'Karan Procurement', 'procurement@test.com', 'demo123', 1, 4, NULL),
  (7, 'Meera Marketing Head', 'marketing@test.com', 'demo123', 1, 2, NULL),
  (8, 'Dev Department Head', 'depthead@test.com', 'demo123', 1, 1, NULL),
  (9, 'CFO Demo', 'cfo@test.com', 'demo123', 1, 4, NULL),
  (10, 'Admin Demo', 'admin@test.com', 'demo123', 1, 4, NULL);

INSERT IGNORE INTO user_roles (user_id, role_id) VALUES
  (1, 1),
  (2, 2),
  (3, 4),
  (4, 6),
  (5, 7),
  (6, 8),
  (7, 9),
  (8, 3),
  (9, 5),
  (10, 10);

INSERT IGNORE INTO expense_categories (id, name, code, soft_limit) VALUES
  (1, 'Travel', 'travel', 500.00),
  (2, 'Tech', 'tech', 1500.00),
  (3, 'Marketing', 'marketing', 1000.00);

INSERT IGNORE INTO approval_flows (category_id, step_order, role_id) VALUES
  (1, 1, 4),
  (1, 2, 6),
  (1, 3, 3),
  (2, 1, 7),
  (2, 2, 4),
  (2, 3, 8),
  (3, 1, 9),
  (3, 2, 4);
