require("dotenv").config();

const express = require("express");
const path = require("path");
const multer = require("multer");
const session = require("express-session");
const {
  getCountryCurrencyRows,
  initDatabase,
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
  ceoOverride,
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
} = require("./store");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "reimbursement-demo-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.userId ? await getUserById(req.session.userId) : null;
  res.locals.roleBadge = res.locals.currentUser ? getRoleLabel(res.locals.currentUser.role_code) : "";
  res.locals.statusLabel = getStatusLabel;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login?error=Please login to continue");
  }
  next();
}

function requireRole(roleCode) {
  return async (req, res, next) => {
    const user = await getUserById(req.session.userId);
    if (!user || user.role_code !== roleCode) {
      return res.redirect("/redirect-by-role");
    }
    req.user = user;
    next();
  };
}

function requireAnyRole(roleCodes) {
  return async (req, res, next) => {
    const user = await getUserById(req.session.userId);
    if (!user || !roleCodes.includes(user.role_code)) {
      return res.redirect("/redirect-by-role");
    }
    req.user = user;
    next();
  };
}

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/redirect-by-role");
  }
  return res.redirect("/login");
});

app.get("/login", async (req, res) => {
  res.render("auth-login", {
    pageTitle: "Login",
    message: req.query.message || "",
    error: req.query.error || "",
  });
});

app.post("/login", async (req, res) => {
  try {
    const user = await authenticateUser(req.body.email, req.body.password);
    if (!user) {
      return res.redirect("/login?error=Invalid email or password");
    }
    req.session.userId = user.id;
    return res.redirect(`${getRoleRedirect(user.role_code)}?message=${encodeURIComponent(`Welcome back, ${user.role_name}`)}`);
  } catch (error) {
    return res.redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
});

app.get("/signup", (req, res) => {
  getCountryCurrencyRows()
    .then((countryRows) => {
      res.render("auth-signup", {
        pageTitle: "Signup",
        message: req.query.message || "",
        error: req.query.error || "",
        countryRows,
      });
    })
    .catch((error) => {
      res.render("auth-signup", {
        pageTitle: "Signup",
        message: req.query.message || "",
        error: req.query.error || error.message,
        countryRows: [],
      });
    });
});

app.post("/signup", async (req, res) => {
  try {
    const { company_name, country, email, password, confirm_password } = req.body;
    if (password !== confirm_password) {
      return res.redirect("/signup?error=Passwords do not match");
    }
    const result = await createCompanySetup({ company_name, country, email, password });
    return res.redirect(`/login?message=${encodeURIComponent(`Your company workspace is ready. Base currency: ${result.currency}`)}`);
  } catch (error) {
    return res.redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }
});

app.get("/api/countries", async (req, res) => {
  try {
    const countryRows = await getCountryCurrencyRows();
    res.json({ ok: true, countries: countryRows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, countries: [] });
  }
});

app.get("/forgot-password", (req, res) => {
  res.redirect("/login?message=Demo mode: use password demo123 for seeded users");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login?message=Logged out successfully"));
});

app.post("/session/refresh-logout", (req, res) => {
  if (!req.session) {
    return res.status(204).end();
  }
  req.session.destroy(() => res.status(204).end());
});

app.get("/redirect-by-role", requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  return res.redirect(getRoleRedirect(user.role_code));
});

app.get("/dashboard/employee", requireAuth, requireRole("employee"), async (req, res, next) => {
  try {
    const [employeeClaims, timeline, categories, notifications, historyFeed] = await Promise.all([
      getClaimsForEmployee(req.user.id),
      getEmployeeTimeline(req.user.id),
      getCategories(),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-employee", {
      pageTitle: "Employee Dashboard",
      message: req.query.message || "",
      error: req.query.error || "",
      categories,
      employeeClaims,
      timeline,
      notifications,
      historyFeed,
      companyCurrency: req.user.currency_code || "INR",
      managerConfigured: Boolean(req.user.manager_user_id),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/manager", requireAuth, requireRole("manager"), async (req, res, next) => {
  try {
    const [managerQueue, teamMembers, notifications, historyFeed] = await Promise.all([
      getManagerQueue(req.user.id),
      getManagerTeam(req.user.id),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-manager", {
      pageTitle: "Manager Approvals",
      message: req.query.message || "",
      error: req.query.error || "",
      managerQueue,
      teamMembers,
      notifications,
      historyFeed,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/finance", requireAuth, requireRole("finance"), async (req, res, next) => {
  try {
    const [stats, financeQueue, reviewQueue, notifications, historyFeed] = await Promise.all([
      getOverviewStats(req.user.company_id || 1),
      getFinanceQueue(req.user.company_id || 1),
      getReviewerQueue(req.user.id),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-finance", {
      pageTitle: "Finance Dashboard",
      message: req.query.message || "",
      error: req.query.error || "",
      stats,
      financeQueue,
      reviewQueue,
      notifications,
      historyFeed,
      companyCurrency: req.user.currency_code || "INR",
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/cfo", requireAuth, requireRole("cfo"), async (req, res, next) => {
  try {
    const [summary, reviewQueue, notifications, historyFeed] = await Promise.all([
      getExecutiveSummary(req.user.company_id || 1),
      getReviewerQueue(req.user.id),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-cfo", {
      pageTitle: "Executive Summary",
      message: req.query.message || "",
      error: req.query.error || "",
      summary,
      reviewQueue,
      notifications,
      historyFeed,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/ceo", requireAuth, requireRole("ceo"), async (req, res, next) => {
  try {
    const [ceoQueue, notifications, historyFeed] = await Promise.all([
      getCeoQueue(req.user.company_id || 1),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-ceo", {
      pageTitle: "CEO Override Desk",
      message: req.query.message || "",
      error: req.query.error || "",
      ceoQueue,
      notifications,
      historyFeed,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/reviewer", requireAuth, requireAnyRole(["department_head", "ops", "procurement", "tech_head", "marketing_head", "senior_manager"]), async (req, res, next) => {
  try {
    const [reviewQueue, notifications, historyFeed] = await Promise.all([
      getReviewerQueue(req.user.id),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-reviewer", {
      pageTitle: "Reviewer Desk",
      message: req.query.message || "",
      error: req.query.error || "",
      reviewQueue,
      notifications,
      historyFeed,
      reviewerLabel: req.user.role_name,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/admin", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const [config, stats, roles, departments, managers, categories, notifications, historyFeed] = await Promise.all([
      getAdminConfigData(req.user.company_id || 1),
      getOverviewStats(req.user.company_id || 1),
      getRolesForAdmin(),
      getDepartments(),
      getUsersByRole("manager", req.user.company_id || 1),
      getCategories(),
      getNotifications(req.user.id),
      getHistoryFeed(req.user.id, req.user.role_code, req.user.company_id || 1),
    ]);
    res.render("dashboard-admin", {
      pageTitle: "Admin Control",
      message: req.query.message || "",
      error: req.query.error || "",
      config,
      stats,
      roles,
      departments,
      managers,
      categories,
      notifications,
      historyFeed,
      companyCountry: req.user.country || "Configured",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/claims", requireAuth, requireRole("employee"), upload.single("receipt"), async (req, res) => {
  try {
    await createClaim({
      employeeId: req.user.id,
      categoryId: Number(req.body.category_id),
      amount: Number(req.body.amount),
      reportedCurrency: req.body.reported_currency || req.user.currency_code || "INR",
      description: req.body.description,
      remarks: req.body.remarks,
      expenseDate: req.body.expense_date,
      receipt: req.file,
      submitAnyway: req.body.submit_anyway === "1",
      employeeJustification: req.body.employee_justification || "",
    });
    res.redirect("/dashboard/employee?message=Claim submitted successfully");
  } catch (error) {
    res.redirect(`/dashboard/employee?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/claims/precheck", requireAuth, requireRole("employee"), upload.single("receipt"), async (req, res) => {
  try {
    const analysis = await precheckClaim({
      employeeId: req.user.id,
      categoryId: Number(req.body.category_id),
      amount: Number(req.body.amount),
      reportedCurrency: req.body.reported_currency || req.user.currency_code || "INR",
      description: req.body.description,
      remarks: req.body.remarks,
      expenseDate: req.body.expense_date,
      receipt: req.file,
    });

    res.json({
      ok: true,
      warnings: analysis.warnings,
      summary: analysis.summary,
      authenticity_status: analysis.authenticityStatus,
      risk_score: analysis.riskScore,
      ocr: {
        vendor: analysis.ocr.vendor,
        amount: analysis.ocr.amount,
        date: analysis.ocr.date,
        bill_ref: analysis.ocr.billRef,
        status: analysis.ocr.status,
      },
      converted_amount: analysis.convertedAmount,
      company_currency: analysis.companyCurrency,
      formatted_request: analysis.formattedRequest,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/claims/:claimId/approve", requireAuth, requireRole("manager"), async (req, res) => {
  try {
    await approveStep(Number(req.params.claimId), req.user.id);
    res.redirect("/dashboard/manager?message=Approval recorded");
  } catch (error) {
    res.redirect(`/dashboard/manager?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/claims/:claimId/reject", requireAuth, requireRole("manager"), async (req, res) => {
  try {
    await rejectStep(Number(req.params.claimId), req.user.id, req.body.comment || "");
    res.redirect("/dashboard/manager?message=Claim rejected");
  } catch (error) {
    res.redirect(`/dashboard/manager?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/reviews/:claimId/approve", requireAuth, requireAnyRole(["finance", "cfo", "department_head", "ops", "procurement", "tech_head", "marketing_head", "senior_manager"]), async (req, res) => {
  try {
    await approveStep(Number(req.params.claimId), req.user.id);
    return res.redirect(`${getRoleRedirect(req.user.role_code)}?message=Review recorded`);
  } catch (error) {
    return res.redirect(`${getRoleRedirect(req.user.role_code)}?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/reviews/:claimId/reject", requireAuth, requireAnyRole(["finance", "cfo", "department_head", "ops", "procurement", "tech_head", "marketing_head", "senior_manager"]), async (req, res) => {
  try {
    await rejectStep(Number(req.params.claimId), req.user.id, req.body.comment || "");
    return res.redirect(`${getRoleRedirect(req.user.role_code)}?message=Review recorded`);
  } catch (error) {
    return res.redirect(`${getRoleRedirect(req.user.role_code)}?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/ceo/:claimId/:decision", requireAuth, requireRole("ceo"), async (req, res) => {
  try {
    await ceoOverride(Number(req.params.claimId), req.user.id, req.params.decision);
    res.redirect("/dashboard/ceo?message=CEO override recorded");
  } catch (error) {
    res.redirect(`/dashboard/ceo?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await createUserByAdmin({
      companyId: req.user.company_id,
      fullName: req.body.full_name,
      email: req.body.email,
      password: req.body.password,
      roleCode: req.body.role_code,
      departmentId: Number(req.body.department_id) || null,
      managerUserId: Number(req.body.manager_user_id) || null,
    });
    res.redirect("/dashboard/admin?message=User created successfully");
  } catch (error) {
    res.redirect(`/dashboard/admin?error=${encodeURIComponent(error.message)}`);
  }
});

app.post("/admin/flows", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const roleCodes = [req.body.step_one_role, req.body.step_two_role, req.body.step_three_role];
    await saveApprovalFlow({
      categoryId: Number(req.body.category_id),
      roleCodes,
    });
    res.redirect("/dashboard/admin?message=Approval flow updated");
  } catch (error) {
    res.redirect(`/dashboard/admin?error=${encodeURIComponent(error.message)}`);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", {
    pageTitle: "Something went wrong",
    error,
  });
});

const port = Number(process.env.PORT || 3000);

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Reimbursement Manager running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database", error);
    process.exit(1);
  });
