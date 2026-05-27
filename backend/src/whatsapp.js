const EventEmitter = require("events");
const QRCode = require("qrcode");
const puppeteer = require("puppeteer");
const { Client, LocalAuth } = require("whatsapp-web.js");
const {
  buildAnalytics,
  fetchMessages,
  fetchTodayMessages,
  insertMessage,
  normalizeMessage,
} = require("./messages");
const {
  enrichEmployee,
  fetchEmployeeBySession,
  fetchEmployees,
  incrementMessageCount,
  setEmployeeConnected,
} = require("./store");

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

function buildActivitySummaries(messages) {
  const summaryBySession = new Map();

  for (const message of messages) {
    const sessionName = message.employee_session;
    const current =
      summaryBySession.get(sessionName) ||
      {
        last_active: null,
        recent_message: null,
        recent_customer: null,
        recent_message_at: null,
        today_message_count: 0,
      };

    current.last_active = message.timestamp ?? message.created_at ?? current.last_active;
    current.recent_customer = message.sender;
    current.recent_message = message.message;
    current.recent_message_at = message.timestamp ?? message.created_at;
    current.today_message_count += 1;

    summaryBySession.set(sessionName, current);
  }

  return summaryBySession;
}

function isRenderDeployment() {
  return process.env.RENDER === "true" || process.env.RENDER === "1";
}

function isProductionDeployment() {
  return process.env.NODE_ENV === "production";
}

function resolveChromiumExecutablePath(localChromePath) {
  if (isRenderDeployment() || isProductionDeployment()) {
    return puppeteer.executablePath();
  }

  return localChromePath || null;
}

class WhatsAppManager extends EventEmitter {
  constructor({ supabase, io, sessionDir, chromePath }) {
    super();
    this.supabase = supabase;
    this.io = io;
    this.sessionDir = sessionDir;
    this.chromePath = chromePath;
    this.renderMode = isRenderDeployment() || isProductionDeployment();
    this.resolvedChromiumPath = resolveChromiumExecutablePath(chromePath);
    this.clients = new Map();
    this.states = new Map();

    // eslint-disable-next-line no-console
    console.log(
      `[whatsapp] renderMode=${this.renderMode} nodeEnv=${process.env.NODE_ENV || "undefined"} chromiumPath=${this.resolvedChromiumPath || "default"} localChromePath=${this.chromePath || "none"}`,
    );
  }

  getState(sessionName) {
    return (
      this.states.get(sessionName) || {
        status: "offline",
        connected: false,
        qrDataUrl: null,
        qrText: null,
        lastError: null,
      }
    );
  }

  logError(context, error) {
    // eslint-disable-next-line no-console
    console.error(`[${context}] ${formatError(error)}`);
  }

  safeEmit(event, payload, context = event) {
    try {
      this.io.emit(event, payload);
      return true;
    } catch (error) {
      this.logError(`socket.emit:${context}`, error);
      return false;
    }
  }

  async getSnapshot() {
    const [rows, todayMessages] = await Promise.all([
      fetchEmployees(this.supabase),
      fetchTodayMessages(this.supabase),
    ]);

    const summaries = buildActivitySummaries(todayMessages);
    const employees = rows.map((row) =>
      enrichEmployee(row, this.getState(row.session_name), summaries.get(row.session_name)),
    );
    const analytics = buildAnalytics({ employees, messages: todayMessages });

    return {
      employees,
      analytics,
    };
  }

  async getOverview() {
    return this.getSnapshot();
  }

  async getEmployee(sessionName) {
    const employee = await fetchEmployeeBySession(this.supabase, sessionName);
    if (!employee) {
      return null;
    }

    const { employees } = await this.getSnapshot();
    return employees.find((row) => row.session_name === sessionName) ?? enrichEmployee(employee, this.getState(sessionName));
  }

  async getMessages(sessionName = null, limit = 100) {
    const [employees, messages] = await Promise.all([
      fetchEmployees(this.supabase),
      fetchMessages(this.supabase, { sessionName, limit }),
    ]);

    const employeeBySession = new Map(employees.map((employee) => [employee.session_name, employee]));
    return messages.map((message) =>
      normalizeMessage(message, employeeBySession.get(message.employee_session)?.name ?? null),
    );
  }

  async getAnalytics() {
    const { analytics } = await this.getSnapshot();
    return analytics;
  }

  async bootConnectedSessions() {
    const rows = await fetchEmployees(this.supabase);
    const activeRows = rows.filter((row) => row.connected);

    for (const employee of activeRows) {
      try {
        await this.startSession(employee);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Failed to boot WhatsApp session for ${employee.session_name}:`, error);
      }
    }
  }

  async startSession(employee) {
    const sessionName = employee.session_name;
    const existingClient = this.clients.get(sessionName);
    if (existingClient) {
      return this.getEmployee(sessionName);
    }

    const currentState = this.getState(sessionName);
    if (currentState.status === "connecting" || currentState.status === "qr") {
      return this.getEmployee(sessionName);
    }

    this.states.set(sessionName, {
      status: "connecting",
      connected: false,
      qrDataUrl: null,
      qrText: null,
      lastError: null,
    });

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionName,
        dataPath: this.sessionDir,
      }),
      puppeteer: {
        headless: this.renderMode,
        ...(this.resolvedChromiumPath ? { executablePath: this.resolvedChromiumPath } : {}),
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      },
    });

    this.clients.set(sessionName, client);
    this.attachListeners(client, employee);

    try {
      await client.initialize();
    } catch (error) {
      const readableError = formatError(error);
      this.clients.delete(sessionName);
      this.states.set(sessionName, {
        status: "error",
        connected: false,
        qrDataUrl: null,
        qrText: null,
        lastError: readableError,
      });
      await setEmployeeConnected(this.supabase, sessionName, false).catch(() => null);
      this.safeEmit("session:error", {
        sessionName,
        message: readableError,
      }, "session:error");
      throw error;
    }

    return this.getEmployee(sessionName);
  }

  async captureMessage(employee, message) {
    const sessionName = employee.session_name;
    const sender = message.fromMe
      ? message.to || message.from || message.id?.remote?._serialized || message.id?.remote || "unknown"
      : message.from || message.id?.remote?._serialized || message.id?.remote || "unknown";
    const messageBody =
      typeof message.body === "string" && message.body.trim().length > 0 ? message.body : "[non-text message]";
    const timestamp = message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString();

    const savedMessage = await insertMessage(this.supabase, {
      employee_session: sessionName,
      sender,
      message: messageBody,
      timestamp,
      from_me: Boolean(message.fromMe),
    });

    await incrementMessageCount(this.supabase, sessionName);
    await setEmployeeConnected(this.supabase, sessionName, true);

    const normalizedMessage = normalizeMessage(savedMessage, employee.name);
    const activityPayload = {
      sessionName,
      employee: {
        name: employee.name,
        session_name: sessionName,
      },
      sender,
      message: normalizedMessage,
    };

    this.safeEmit("message:received", activityPayload, "message:received");
    this.safeEmit("employee:activity", {
      sessionName,
      employee: {
        name: employee.name,
        session_name: sessionName,
      },
      sender,
      message: normalizedMessage.message,
      timestamp: normalizedMessage.timestamp ?? normalizedMessage.created_at,
      from_me: normalizedMessage.from_me,
    }, "employee:activity");

    await this.broadcastOverview();
    return normalizedMessage;
  }

  attachListeners(client, employee) {
    const sessionName = employee.session_name;

    client.on("qr", (qrText) => {
      void (async () => {
        const qrDataUrl = await QRCode.toDataURL(qrText, {
          errorCorrectionLevel: "M",
          margin: 1,
          scale: 8,
        });

        this.states.set(sessionName, {
          ...this.getState(sessionName),
          status: "qr",
          connected: false,
          qrDataUrl,
          qrText,
          lastError: null,
        });

        this.safeEmit(
          "session:qr",
          {
            sessionName,
            qrText,
            qrDataUrl,
          },
          "session:qr",
        );
        await this.broadcastOverview();
      })().catch((error) => {
        this.logError(`session:${sessionName}:qr`, error);
      });
    });

    client.on("authenticated", () => {
      this.states.set(sessionName, {
        ...this.getState(sessionName),
        status: "authenticated",
        lastError: null,
      });
      this.safeEmit("session:status", {
        sessionName,
        status: "authenticated",
      }, "session:status");
    });

    client.on("ready", () => {
      void (async () => {
        this.states.set(sessionName, {
          status: "ready",
          connected: true,
          qrDataUrl: null,
          qrText: null,
          lastError: null,
        });

        await setEmployeeConnected(this.supabase, sessionName, true);
        this.safeEmit("session:status", {
          sessionName,
          status: "ready",
          connected: true,
        }, "session:status");
        await this.broadcastOverview();
      })().catch((error) => {
        this.logError(`session:${sessionName}:ready`, error);
      });
    });

    client.on("message_create", async (message) => {
      try {
        if (message.from === "status@broadcast" || message.to === "status@broadcast") {
          return;
        }

        await this.captureMessage(employee, message);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Failed to capture message for ${sessionName}:`, error);
      }
    });

    client.on("auth_failure", (message) => {
      void (async () => {
        const readableMessage = formatError(message);
        this.states.set(sessionName, {
          ...this.getState(sessionName),
          status: "error",
          connected: false,
          lastError: readableMessage,
        });

        await setEmployeeConnected(this.supabase, sessionName, false);
        this.safeEmit("session:error", { sessionName, message: readableMessage }, "session:error");
        await this.broadcastOverview();
      })().catch((error) => {
        this.logError(`session:${sessionName}:auth_failure`, error);
      });
    });

    client.on("disconnected", (reason) => {
      void (async () => {
        const readableReason = formatError(reason);
        this.states.set(sessionName, {
          status: "offline",
          connected: false,
          qrDataUrl: null,
          qrText: null,
          lastError: readableReason,
        });

        this.clients.delete(sessionName);
        await setEmployeeConnected(this.supabase, sessionName, false);
        this.safeEmit("session:status", {
          sessionName,
          status: "offline",
          reason: readableReason,
        }, "session:status");
        await this.broadcastOverview();
      })().catch((error) => {
        this.logError(`session:${sessionName}:disconnected`, error);
      });
    });
  }

  async broadcastOverview() {
    const overview = await this.getOverview();
    this.safeEmit("employees:updated", overview, "employees:updated");
    this.safeEmit("analytics:updated", overview.analytics, "analytics:updated");
    return overview;
  }

  async connect(sessionName) {
    const employee = await fetchEmployeeBySession(this.supabase, sessionName);
    if (!employee) {
      return null;
    }

    const state = this.getState(sessionName);
    if (this.clients.has(sessionName) || state.status === "ready") {
      return this.getEmployee(sessionName);
    }

    return this.startSession(employee);
  }

  async disconnect(sessionName) {
    const client = this.clients.get(sessionName);
    if (client) {
      await client.destroy().catch(() => null);
      this.clients.delete(sessionName);
    }

    this.states.set(sessionName, {
      status: "offline",
      connected: false,
      qrDataUrl: null,
      qrText: null,
      lastError: null,
    });

    await setEmployeeConnected(this.supabase, sessionName, false);
    this.safeEmit("session:status", {
      sessionName,
      status: "offline",
    }, "session:status");
    await this.broadcastOverview();

    return this.getEmployee(sessionName);
  }
}

module.exports = { WhatsAppManager };
