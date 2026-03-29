require("dotenv").config();

const express = require("express");
const path = require("path");
const multer = require("multer");
const session = require("express-session");
const {
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
} = require("./store");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "reimbursement-demo-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(async (req, res, next) => {
  if (req.session.userId) {
    res.locals.currentUser = await getUserById(req.session.userId);
  } else {
    res.locals.currentUser = null;
  }
  res.locals.roleBadge = res.locals.currentUser ? getRoleLabel(res.locals.currentUser.role_code) : "";
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

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/redirect-by-role");
  }
  return res.redirect("/login");
});

app.get("/login", async (req, res) => {
  const quickSwitchUsers = await getQuickSwitchUsers();
  res.render("auth-login", {
    pageTitle: "Login",
    message: req.query.message || "",
    error: req.query.error || "",
    quickSwitchUsers,
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

app.post("/demo-switch", async (req, res) => {
  const user = await getUserById(Number(req.body.user_id));
  if (!user) {
    return res.redirect("/login?error=Demo user not found");
  }
  req.session.userId = user.id;
  return res.redirect(`${getRoleRedirect(user.role_code)}?message=${encodeURIComponent(`Welcome back, ${user.role_name}`)}`);
});

app.get("/signup", (req, res) => {
  res.render("auth-signup", {
    pageTitle: "Signup",
    message: req.query.message || "",
    error: req.query.error || "",
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

app.get("/forgot-password", (req, res) => {
  res.redirect("/login?message=Demo mode: use password demo123 for seeded users");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login?message=Logged out successfully");
  });
});

app.get("/redirect-by-role", requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  return res.redirect(getRoleRedirect(user.role_code));
});

app.get("/dashboard/employee", requireAuth, requireRole("employee"), async (req, res, next) => {
  try {
    const [employeeClaims, timeline, categories, managers] = await Promise.all([
      getClaimsForEmployee(req.user.id),
      getEmployeeTimeline(req.user.id),
      getCategories(),
      getUsersByRole("manager"),
    ]);
    res.render("dashboard-employee", {
      pageTitle: "Employee Dashboard",
      message: req.query.message || "",
      error: req.query.error || "",
      categories,
      managers,
      employeeClaims,
      timeline,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/manager", requireAuth, requireRole("manager"), async (req, res, next) => {
  try {
    const managerQueue = await getManagerQueue(req.user.id);
    res.render("dashboard-manager", {
      pageTitle: "Manager Approvals",
      message: req.query.message || "",
      error: req.query.error || "",
      managerQueue,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/finance", requireAuth, requireRole("finance"), async (req, res, next) => {
  try {
    const [stats, financeQueue] = await Promise.all([
      getOverviewStats(req.user.company_id || 1),
      getFinanceQueue(req.user.company_id || 1),
    ]);
    res.render("dashboard-finance", {
      pageTitle: "Finance Dashboard",
      message: req.query.message || "",
      error: req.query.error || "",
      stats,
      financeQueue,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/cfo", requireAuth, requireRole("cfo"), async (req, res, next) => {
  try {
    const summary = await getExecutiveSummary(req.user.company_id || 1);
    res.render("dashboard-cfo", {
      pageTitle: "Executive Summary",
      message: req.query.message || "",
      error: req.query.error || "",
      summary,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard/admin", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const [config, stats] = await Promise.all([
      getAdminConfigData(req.user.company_id || 1),
      getOverviewStats(req.user.company_id || 1),
    ]);
    res.render("dashboard-admin", {
      pageTitle: "Admin Control",
      message: req.query.message || "",
      error: req.query.error || "",
      config,
      stats,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/claims", requireAuth, requireRole("employee"), upload.single("receipt"), async (req, res) => {
  try {
    await createClaim({
      employeeId: req.user.id,
      managerId: Number(req.body.manager_id),
      categoryId: Number(req.body.category_id),
      amount: Number(req.body.amount),
      description: req.body.description,
      expenseDate: req.body.expense_date,
      receipt: req.file,
    });
    res.redirect("/dashboard/employee?message=Claim submitted successfully");
  } catch (error) {
    res.redirect(`/dashboard/employee?error=${encodeURIComponent(error.message)}`);
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
