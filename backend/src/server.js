const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const rootEnvPath = path.join(__dirname, "..", "..", ".env");
const backendEnvPath = path.join(__dirname, "..", ".env");

require("dotenv").config({ path: rootEnvPath });
require("dotenv").config({ path: backendEnvPath, override: false });

const { supabase } = require("./supabase");
const {
  fetchEmployeeBySession,
  fetchEmployees,
  seedEmployeesIfNeeded,
} = require("./store");
const { WhatsAppManager } = require("./whatsapp");

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message || String(error);
  }

  if (error && typeof error === "object") {
    const parts = [];

    if (typeof error.name === "string" && error.name.trim()) {
      parts.push(error.name.trim());
    }

    if (typeof error.message === "string" && error.message.trim()) {
      parts.push(error.message.trim());
    }

    if (typeof error.code === "string" && error.code.trim()) {
      parts.push(`code=${error.code.trim()}`);
    }

    if (typeof error.details === "string" && error.details.trim()) {
      parts.push(`details=${error.details.trim()}`);
    }

    if (typeof error.hint === "string" && error.hint.trim()) {
      parts.push(`hint=${error.hint.trim()}`);
    }

    if (parts.length > 0) {
      return parts.join(" | ");
    }

    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
}

const PORT = Number(process.env.PORT || 5000);
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
const sessionDir =
  process.env.SESSION_DIR ||
  path.join(__dirname, "..", ".wwebjs_auth");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  },
});

const manager = new WhatsAppManager({
  supabase,
  io,
  sessionDir,
  chromePath,
});

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled promise rejection:", formatError(reason));
});

process.on("uncaughtException", (error) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught exception:", formatError(error));
});

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

const seedEmployees = [
  { name: "Rahul", session_name: "rahul_session", connected: false, total_messages: 0 },
  { name: "Aman", session_name: "aman_session", connected: false, total_messages: 0 },
  { name: "Priya", session_name: "priya_session", connected: false, total_messages: 0 },
];

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/employees", async (_req, res) => {
  try {
    const overview = await manager.getOverview();
    res.json(overview);
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.get("/messages", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const sessionName = typeof req.query.session === "string" && req.query.session.trim() ? req.query.session.trim() : null;
    const messages = await manager.getMessages(sessionName, limit);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.get("/messages/:session", async (req, res) => {
  try {
    const sessionName = req.params.session;
    const employee = await fetchEmployeeBySession(supabase, sessionName);

    if (!employee) {
      return res.status(404).json({ error: "Employee session not found" });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const messages = await manager.getMessages(sessionName, limit);
    res.json({ sessionName, messages });
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.get("/analytics", async (_req, res) => {
  try {
    const analytics = await manager.getAnalytics();
    res.json({ analytics });
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.post("/connect/:session", async (req, res) => {
  try {
    const { session } = req.params;
    const employee = await fetchEmployeeBySession(supabase, session);

    if (!employee) {
      return res.status(404).json({ error: "Employee session not found" });
    }

    const updated = await manager.connect(session);
    return res.json({
      ok: true,
      employee: updated,
      message: "WhatsApp session is starting",
    });
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.post("/disconnect/:session", async (req, res) => {
  try {
    const { session } = req.params;
    const employee = await fetchEmployeeBySession(supabase, session);

    if (!employee) {
      return res.status(404).json({ error: "Employee session not found" });
    }

    const updated = await manager.disconnect(session);
    return res.json({
      ok: true,
      employee: updated,
      message: "WhatsApp session disconnected",
    });
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

app.get("/status/:session", async (req, res) => {
  try {
    const { session } = req.params;
    const employee = await fetchEmployeeBySession(supabase, session);

    if (!employee) {
      return res.status(404).json({ error: "Employee session not found" });
    }

    const overview = await manager.getEmployee(session);
    res.json(overview);
  } catch (error) {
    res.status(500).json({ error: formatError(error) });
  }
});

io.on("connection", (socket) => {
  socket.emit("server:ready", { ok: true });
});

async function start() {
  try {
    await seedEmployeesIfNeeded(supabase, seedEmployees);
    const employees = await fetchEmployees(supabase);
    await manager.broadcastOverview();

    if (employees.some((employee) => employee.connected)) {
      await manager.bootConnectedSessions();
    }

    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to start backend:", formatError(error));
    process.exit(1);
  }
}

start();
