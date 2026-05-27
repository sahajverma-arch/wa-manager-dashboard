"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { io, Socket } from "socket.io-client";

type Employee = {
  id: string;
  name: string;
  session_name: string;
  connected: boolean;
  total_messages: number;
  last_active: string | null;
  created_at: string;
  runtime_status?: "offline" | "connecting" | "qr" | "authenticated" | "ready" | "error";
  qr_data_url?: string | null;
  recent_message?: string | null;
  recent_customer?: string | null;
  recent_message_at?: string | null;
  today_message_count?: number;
};

type MessageItem = {
  id: string;
  employee_session: string;
  sender: string;
  message: string;
  timestamp: string | null;
  from_me: boolean;
  created_at: string | null;
  employee_name?: string | null;
};

type MostActiveEmployee = {
  session_name: string;
  employee_name: string;
  total_messages_today: number;
  active_chats?: number;
};

type ActivityItem = {
  session_name: string;
  employee_name: string;
  timestamp: string | null;
  sender: string;
  message: string;
  from_me: boolean;
};

type Analytics = {
  totalMessagesToday: number;
  averageResponseTimeMinutes: number;
  activeEmployees: number;
  connectedEmployees: number;
  unansweredChats: number;
  totalChatsToday: number;
  activeChatsCount: number;
  mostActiveEmployee: MostActiveEmployee | null;
  messagesPerEmployee: MostActiveEmployee[];
  messagesPerHour: { hour: string; count: number }[];
  alerts: AlertItem[];
  lastEmployeeActivity: ActivityItem[];
  activityTimeline: ActivityItem[];
};

type AlertItem = {
  type: string;
  severity: "low" | "medium" | "high";
  title?: string;
  description?: string;
  session_name?: string | null;
  employee_name?: string | null;
  sender?: string | null;
  message?: string | null;
  keyword?: string | null;
  timestamp?: string | null;
};

type Overview = {
  employees: Employee[];
  analytics: Analytics;
};

type MessagesResponse = {
  messages: MessageItem[];
};

type AnalyticsResponse = {
  analytics: Analytics;
};

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5000";

const EMPTY_ANALYTICS: Analytics = {
  totalMessagesToday: 0,
  averageResponseTimeMinutes: 0,
  activeEmployees: 0,
  connectedEmployees: 0,
  unansweredChats: 0,
  totalChatsToday: 0,
  activeChatsCount: 0,
  mostActiveEmployee: null,
  messagesPerEmployee: [],
  messagesPerHour: [],
  alerts: [],
  lastEmployeeActivity: [],
  activityTimeline: [],
};

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "No activity";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No activity";
  }

  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatClock(value: string | null | undefined) {
  if (!value) {
    return "--:--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelative(value: string | null | undefined, now: number) {
  if (!value) {
    return "No recent activity";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No recent activity";
  }

  const diff = now - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) {
    return "Just now";
  }
  if (diff < hour) {
    return `${Math.round(diff / minute)}m ago`;
  }
  if (diff < day) {
    return `${Math.round(diff / hour)}h ago`;
  }
  return `${Math.round(diff / day)}d ago`;
}

function formatResponseTime(minutes: number) {
  if (!minutes || minutes <= 0) {
    return "N/A";
  }

  const totalSeconds = Math.max(1, Math.round(minutes * 60));
  const hours = Math.floor(totalSeconds / 3600);
  const remainingMinutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }

  return `${remainingMinutes}m ${seconds}s`;
}

function shortSender(value: string | null | undefined) {
  if (!value) {
    return "Unknown customer";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

type PillTone = "success" | "warning" | "danger" | "muted" | "info";

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  const styles: Record<PillTone, string> = {
    success: "bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/25",
    warning: "bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/25",
    danger: "bg-rose-400/15 text-rose-300 ring-1 ring-rose-400/25",
    muted: "bg-slate-500/10 text-slate-300 ring-1 ring-slate-500/20",
    info: "bg-cyan-400/15 text-cyan-300 ring-1 ring-cyan-400/25",
  };

  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${styles[tone]}`}>
      {children}
    </span>
  );
}

function MetricCard({
  title,
  value,
  description,
  accent,
}: {
  title: string;
  value: number | string;
  description: string;
  accent: string;
}) {
  return (
    <div className="glass-panel rounded-[1.75rem] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-300/80">{title}</p>
          <div className="mt-2 text-3xl font-semibold tracking-tight text-white">{value}</div>
        </div>
        <div className={`h-11 w-11 rounded-2xl ${accent}`} />
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-400">{description}</p>
    </div>
  );
}

function SectionHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description: string;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">{description}</p>
        </div>
        {meta ? <div className="text-sm text-slate-400">{meta}</div> : null}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  employeeName,
}: {
  message: MessageItem;
  employeeName: string;
}) {
  const outgoing = message.from_me;

  return (
    <div className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[92%] rounded-[1.35rem] px-4 py-3 ${
        outgoing
          ? "bg-emerald-400/15 text-emerald-50 ring-1 ring-emerald-400/20"
          : "bg-white/5 text-slate-100 ring-1 ring-white/10"
      }`}>
        <div className="flex items-center justify-between gap-4 text-xs text-slate-400">
          <span className="font-medium text-slate-200">{outgoing ? employeeName : "Customer"}</span>
          <span>{formatClock(message.timestamp ?? message.created_at)}</span>
        </div>
        <div className="mt-1 text-sm leading-6 text-slate-100">{message.message}</div>
        <div className="mt-2 text-[11px] uppercase tracking-[0.24em] text-slate-500">
          {outgoing ? "Outgoing" : "Incoming"} · {shortSender(message.sender)}
        </div>
      </div>
    </div>
  );
}

function BarRow({
  label,
  value,
  maxValue,
}: {
  label: string;
  value: number;
  maxValue: number;
}) {
  const width = maxValue > 0 ? Math.max(8, (value / maxValue) * 100) : 8;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-slate-200">{label}</span>
        <span className="mono text-slate-400">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/6">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,rgba(97,242,182,0.95),rgba(103,167,255,0.95))]"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

type ConversationSummary = {
  key: string;
  employee_session: string;
  employee_name: string;
  sender: string;
  latestAt: string | null;
  latestMessage: string;
  latestFromMe: boolean;
  unanswered: boolean;
  active: boolean;
  minutesSinceLatest: number | null;
  messageCount: number;
};

function toMillisSafe(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function buildConversationSummaries(messages: MessageItem[], employees: Employee[], now: number) {
  const employeeBySession = new Map(employees.map((employee) => [employee.session_name, employee]));
  const sortedMessages = [...messages].sort(
    (a, b) => (toMillisSafe(a.timestamp ?? a.created_at) ?? 0) - (toMillisSafe(b.timestamp ?? b.created_at) ?? 0),
  );
  const conversations = new Map<string, ConversationSummary>();

  for (const message of sortedMessages) {
    const sender = message.sender || "unknown";
    const key = `${message.employee_session}::${sender}`;
    const timestamp = message.timestamp ?? message.created_at ?? null;
    const current =
      conversations.get(key) ||
      {
        key,
        employee_session: message.employee_session,
        employee_name: employeeBySession.get(message.employee_session)?.name ?? message.employee_session,
        sender,
        latestAt: null,
        latestMessage: "",
        latestFromMe: false,
        unanswered: false,
        active: false,
        minutesSinceLatest: null,
        messageCount: 0,
      };

    current.messageCount += 1;
    current.latestAt = timestamp;
    current.latestMessage = message.message;
    current.latestFromMe = message.from_me;
    current.unanswered = !message.from_me;

    const latestTime = toMillisSafe(timestamp);
    current.minutesSinceLatest = latestTime === null ? null : Math.max(0, Math.round((now - latestTime) / 60000));
    current.active = current.minutesSinceLatest !== null && current.minutesSinceLatest <= 60;

    conversations.set(key, current);
  }

  return Array.from(conversations.values()).sort(
    (a, b) => (toMillisSafe(b.latestAt) ?? 0) - (toMillisSafe(a.latestAt) ?? 0),
  );
}

function conversationMatchesStatus(conversation: ConversationSummary, chatFilter: string) {
  if (chatFilter === "active") {
    return conversation.active;
  }
  if (chatFilter === "inactive") {
    return !conversation.active;
  }
  if (chatFilter === "unanswered") {
    return conversation.unanswered;
  }

  return true;
}

function messageMatchesSearch(message: MessageItem, employeeName: string | undefined, query: string) {
  if (!query) {
    return true;
  }

  const haystack = [message.sender, message.message, message.employee_session, employeeName ?? ""].join(" ").toLowerCase();
  return haystack.includes(query);
}

function buildScopedAnalytics({
  employees,
  messages,
  conversations,
  now,
}: {
  employees: Employee[];
  messages: MessageItem[];
  conversations: ConversationSummary[];
  now: number;
}): Analytics {
  const employeeBySession = new Map(employees.map((employee) => [employee.session_name, employee]));
  const perEmployee = new Map<string, { count: number; activeChats: number }>();
  const perHour = new Map<string, number>();
  const responseTimes: number[] = [];
  const alerts: AlertItem[] = [];
  const latestActivity = new Map<string, ActivityItem>();
  const conversationState = new Map<string, { lastIncomingAt: number | null }>();
  const sortedMessages = [...messages].sort(
    (a, b) => (toMillisSafe(a.timestamp ?? a.created_at) ?? 0) - (toMillisSafe(b.timestamp ?? b.created_at) ?? 0),
  );

  for (const message of sortedMessages) {
    const employee = employeeBySession.get(message.employee_session);
    const timestamp = message.timestamp ?? message.created_at ?? null;
    const millis = toMillisSafe(timestamp);
    const hour = millis === null ? null : `${String(new Date(millis).getHours()).padStart(2, "0")}:00`;
    const key = `${message.employee_session}::${message.sender || "unknown"}`;

    if (hour) {
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }

    const employeeBucket = perEmployee.get(message.employee_session) || {
      count: 0,
      activeChats: 0,
    };
    employeeBucket.count += 1;
    perEmployee.set(message.employee_session, employeeBucket);

    latestActivity.set(message.employee_session, {
      session_name: message.employee_session,
      employee_name: employee?.name ?? message.employee_session,
      timestamp,
      sender: message.sender,
      message: message.message,
      from_me: message.from_me,
    });

    const state = conversationState.get(key) || { lastIncomingAt: null };
    if (!message.from_me) {
      state.lastIncomingAt = millis;
    } else if (state.lastIncomingAt !== null && millis !== null) {
      responseTimes.push(millis - state.lastIncomingAt);
      state.lastIncomingAt = null;
    }
    conversationState.set(key, state);
  }

  for (const conversation of conversations) {
    const employeeBucket = perEmployee.get(conversation.employee_session);
    if (employeeBucket && conversation.active) {
      employeeBucket.activeChats += 1;
    }

    if (conversation.unanswered && conversation.minutesSinceLatest !== null && conversation.minutesSinceLatest > 30) {
      alerts.push({
        type: "stale_reply",
        severity: conversation.minutesSinceLatest >= 120 ? "high" : "medium",
        title: "No reply in 30+ mins",
        description: `${conversation.sender} is waiting on ${conversation.employee_name}`,
        session_name: conversation.employee_session,
        employee_name: conversation.employee_name,
        sender: conversation.sender,
        timestamp: conversation.latestAt,
      });
    }

    if (conversation.latestMessage) {
      const text = conversation.latestMessage.toLowerCase();
      const keyword = ["refund", "complaint", "bad", "issue"].find((entry) => text.includes(entry));
      if (keyword) {
        alerts.push({
          type: "angry_keyword",
          severity: keyword === "refund" || keyword === "complaint" ? "high" : "medium",
          title: "Angry keyword detected",
          description: `"${keyword}" in message from ${conversation.sender}`,
          session_name: conversation.employee_session,
          employee_name: conversation.employee_name,
          sender: conversation.sender,
          message: conversation.latestMessage,
          keyword,
          timestamp: conversation.latestAt,
        });
      }
    }
  }

  const connectedEmployees = employees.filter((employee) => employee.connected);
  const activeEmployees = connectedEmployees.filter((employee) => {
    const lastActive = toMillisSafe(employee.last_active);
    return lastActive !== null && now - lastActive <= 15 * 60 * 1000;
  });

  for (const employee of connectedEmployees) {
    const lastActive = toMillisSafe(employee.last_active);
    if (lastActive === null) {
      continue;
    }

    const minutesInactive = Math.max(0, Math.round((now - lastActive) / 60000));
    if (minutesInactive >= 45) {
      alerts.push({
        type: "employee_inactive",
        severity: minutesInactive >= 120 ? "high" : "medium",
        title: "Employee inactive",
        description: `${employee.name} inactive for ${minutesInactive} minutes`,
        session_name: employee.session_name,
        employee_name: employee.name,
        timestamp: employee.last_active,
      });
    }
  }

  const unansweredChats = conversations.filter((conversation) => conversation.unanswered).length;
  if (unansweredChats >= 5) {
    alerts.push({
      type: "backlog",
      severity: unansweredChats >= 8 ? "high" : "medium",
      title: "Too many unanswered chats",
      description: `${unansweredChats} conversations need replies`,
    });
  }

  const messagesPerEmployee = employees
    .map((employee) => ({
      session_name: employee.session_name,
      employee_name: employee.name,
      total_messages_today: perEmployee.get(employee.session_name)?.count ?? 0,
      active_chats: perEmployee.get(employee.session_name)?.activeChats ?? 0,
    }))
    .sort((a, b) => b.total_messages_today - a.total_messages_today);

  const mostActiveEmployee = messagesPerEmployee[0] ?? null;
  const averageResponseTimeMinutes =
    responseTimes.length > 0 ? Math.round((responseTimes.reduce((sum, item) => sum + item, 0) / responseTimes.length) * 10) / 10 : 0;

  const messagesPerHour = Array.from(perHour.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, count]) => ({ hour, count }));

  return {
    totalMessagesToday: messages.length,
    averageResponseTimeMinutes,
    activeEmployees: activeEmployees.length,
    connectedEmployees: connectedEmployees.length,
    unansweredChats,
    totalChatsToday: conversations.length,
    activeChatsCount: conversations.filter((conversation) => conversation.active).length,
    mostActiveEmployee,
    messagesPerEmployee,
    messagesPerHour,
    alerts: alerts.sort((a, b) => {
      const rank = { high: 2, medium: 1, low: 0 };
      return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
    }),
    lastEmployeeActivity: Array.from(latestActivity.values())
      .sort((a, b) => (toMillisSafe(b.timestamp) ?? 0) - (toMillisSafe(a.timestamp) ?? 0))
      .slice(0, 8),
    activityTimeline: conversations.slice(0, 12).map((conversation) => ({
      session_name: conversation.employee_session,
      employee_name: conversation.employee_name,
      timestamp: conversation.latestAt,
      sender: conversation.sender,
      message: conversation.latestMessage,
      from_me: conversation.latestFromMe,
    })),
  };
}

export default function Home() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [, setAnalytics] = useState<Analytics>(EMPTY_ANALYTICS);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [savingSession, setSavingSession] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string | null>(null);
  const [drilldownSessionName, setDrilldownSessionName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [chatFilter, setChatFilter] = useState<"all" | "active" | "inactive" | "unanswered">("all");
  const [drilldownCollapsed, setDrilldownCollapsed] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  const selectedEmployee = employees.find((employee) => employee.session_name === activeSessionName) ?? null;
  const selectedDrilldownEmployee =
    employees.find((employee) => employee.session_name === drilldownSessionName) ?? null;
  const modalQrDataUrl = qrDataUrl || selectedEmployee?.qr_data_url || null;
  const modalTone: PillTone = selectedEmployee?.connected
    ? "success"
    : selectedEmployee?.runtime_status === "qr" || selectedEmployee?.runtime_status === "connecting"
      ? "warning"
    : selectedEmployee?.runtime_status === "error"
        ? "danger"
        : "muted";

  const normalizedSearch = normalizeSearch(searchQuery);
  const employeeBySession = new Map(employees.map((employee) => [employee.session_name, employee]));
  const conversationSummaries = buildConversationSummaries(messages, employees, now);
  const conversationSearchMatches = new Set<string>();
  for (const message of messages) {
    const employeeName = employeeBySession.get(message.employee_session)?.name;
    if (messageMatchesSearch(message, employeeName, normalizedSearch)) {
      conversationSearchMatches.add(`${message.employee_session}::${message.sender || "unknown"}`);
    }
  }

  const scopedConversations = conversationSummaries.filter((conversation) => {
    const selectedSessionOk = !drilldownSessionName || conversation.employee_session === drilldownSessionName;
    const statusOk = conversationMatchesStatus(conversation, chatFilter);
    const searchOk =
      normalizedSearch.length === 0 ||
      conversationSearchMatches.has(conversation.key) ||
      [conversation.employee_name, conversation.sender, conversation.latestMessage]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);

    return selectedSessionOk && statusOk && searchOk;
  });

  const scopedConversationKeys = new Set(scopedConversations.map((conversation) => conversation.key));
  const scopedMessages = messages.filter((message) => {
    const employeeName = employeeBySession.get(message.employee_session)?.name;
    const key = `${message.employee_session}::${message.sender || "unknown"}`;
    const selectedSessionOk = !drilldownSessionName || message.employee_session === drilldownSessionName;
    const searchOk = normalizedSearch.length === 0 || messageMatchesSearch(message, employeeName, normalizedSearch);
    return selectedSessionOk && searchOk && scopedConversationKeys.has(key);
  });

  const scopedEmployees = drilldownSessionName
    ? employees.filter((employee) => employee.session_name === drilldownSessionName)
    : employees;

  const scopedAnalytics = buildScopedAnalytics({
    employees: scopedEmployees,
    messages: scopedMessages,
    conversations: scopedConversations,
    now,
  });
  const scopedAlerts = scopedAnalytics.alerts.filter((alert) => {
    if (drilldownSessionName && alert.session_name && alert.session_name !== drilldownSessionName) {
      return false;
    }
    if (!normalizedSearch) {
      return true;
    }
    return [alert.title, alert.description, alert.employee_name, alert.sender, alert.message, alert.keyword]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSearch);
  });
  const activeChats = scopedConversations.filter((conversation) => conversation.unanswered || conversation.active).slice(0, 6);
  const filteredMostActiveEmployee = scopedAnalytics.mostActiveEmployee;
  const liveMessages = scopedMessages.slice(0, 20);
  const tableMessages = scopedMessages.slice(0, 12);

  useEffect(() => {
    activeSessionRef.current = activeSessionName;
  }, [activeSessionName]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 60000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let socket: Socket | null = null;

    const loadData = async () => {
      try {
        const [employeesResponse, messagesResponse, analyticsResponse] = await Promise.all([
          fetch(`${BACKEND_URL}/employees`, { cache: "no-store" }),
          fetch(`${BACKEND_URL}/messages?limit=80`, { cache: "no-store" }),
          fetch(`${BACKEND_URL}/analytics`, { cache: "no-store" }),
        ]);

        if (!employeesResponse.ok) {
          throw new Error(`Unable to load employees (${employeesResponse.status})`);
        }
        if (!messagesResponse.ok) {
          throw new Error(`Unable to load messages (${messagesResponse.status})`);
        }
        if (!analyticsResponse.ok) {
          throw new Error(`Unable to load analytics (${analyticsResponse.status})`);
        }

        const employeesPayload = (await employeesResponse.json()) as Overview;
        const messagesPayload = (await messagesResponse.json()) as MessagesResponse;
        const analyticsPayload = (await analyticsResponse.json()) as AnalyticsResponse;

        setEmployees(employeesPayload.employees);
        setMessages(messagesPayload.messages);
        setAnalytics(analyticsPayload.analytics ?? employeesPayload.analytics ?? EMPTY_ANALYTICS);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard data");
      } finally {
        setLoading(false);
      }
    };

    void loadData();

    socket = io(BACKEND_URL, {
      transports: ["websocket"],
      withCredentials: false,
    });

    socket.on("connect", () => setSocketReady(true));
    socket.on("disconnect", () => setSocketReady(false));

    socket.on("server:ready", () => setSocketReady(true));

    socket.on("employees:updated", (payload: Overview) => {
      setEmployees(payload.employees);
      setAnalytics(payload.analytics);
      setError(null);
    });

    socket.on("analytics:updated", (payload: Analytics) => {
      setAnalytics(payload);
    });

    socket.on(
      "message:received",
      ({
        sessionName,
        employee,
        message,
      }: {
        sessionName: string;
        employee: { name: string; session_name: string };
        message: MessageItem;
      }) => {
        const normalized = {
          ...message,
          employee_name: employee.name,
        };

        setMessages((current) => {
          const next = [normalized, ...current.filter((item) => item.id !== normalized.id)];
          return next.slice(0, 120);
        });

        setEmployees((current) =>
          current.map((row) => {
            if (row.session_name !== sessionName) {
              return row;
            }

            const nextCount = (row.today_message_count ?? row.total_messages ?? 0) + 1;
            return {
              ...row,
              today_message_count: nextCount,
              last_active: normalized.timestamp ?? normalized.created_at ?? row.last_active,
              recent_message: normalized.message,
              recent_customer: normalized.sender,
              recent_message_at: normalized.timestamp ?? normalized.created_at ?? row.recent_message_at ?? null,
            };
          }),
        );

        setAnalytics((current) => ({
          ...current,
          totalMessagesToday: current.totalMessagesToday + 1,
        }));

        setError(null);
      },
    );

    socket.on(
      "employee:activity",
      ({
        sessionName,
        sender,
        message,
        timestamp,
        from_me,
      }: {
        sessionName: string;
        sender: string;
        message: string;
        timestamp: string;
        from_me: boolean;
      }) => {
        setEmployees((current) =>
          current.map((row) =>
            row.session_name === sessionName
              ? {
                  ...row,
                  last_active: timestamp,
                  recent_customer: sender,
                  recent_message: message,
                  recent_message_at: timestamp,
                }
              : row,
          ),
        );

        setAnalytics((current) => ({
          ...current,
          lastEmployeeActivity: [
            {
              session_name: sessionName,
              employee_name: current.lastEmployeeActivity.find((item) => item.session_name === sessionName)?.employee_name ?? sessionName,
              sender,
              message,
              timestamp,
              from_me,
            },
            ...current.lastEmployeeActivity.filter((item) => item.session_name !== sessionName),
          ].slice(0, 8),
        }));
      },
    );

    socket.on("session:qr", ({ sessionName, qrDataUrl: nextQrDataUrl }: { sessionName: string; qrDataUrl: string }) => {
      if (activeSessionRef.current === sessionName) {
        setQrDataUrl(nextQrDataUrl);
      }
    });

    socket.on("session:error", ({ message }: { message: string }) => {
      setError(message);
    });

    return () => {
      socket?.disconnect();
    };
  }, []);

  async function updateSession(action: "connect" | "disconnect", sessionName: string) {
    setSavingSession(sessionName);
    setError(null);

    try {
      const response = await fetch(`${BACKEND_URL}/${action}/${sessionName}`, {
        method: "POST",
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Unable to ${action} ${sessionName}`);
      }

      const payload = (await response.json()) as { employee?: Employee };
      if (action === "connect") {
        setActiveSessionName(sessionName);
        setQrDataUrl(payload.employee?.qr_data_url ?? null);
      } else if (activeSessionName === sessionName) {
        setQrDataUrl(null);
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Unable to ${action}`);
    } finally {
      setSavingSession(null);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="float-slow absolute left-[-7rem] top-[-7rem] h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="float-slow absolute right-[-5rem] top-28 h-80 w-80 rounded-full bg-emerald-400/14 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.04),transparent_30%)]" />
        <div className="absolute inset-x-0 bottom-0 h-56 bg-[linear-gradient(180deg,transparent,rgba(7,18,31,0.96))]" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1600px] flex-col gap-6">
        <section className="glass-panel rounded-[2rem] p-6 sm:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-4xl">
              <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-200 ring-1 ring-white/10">
                Manager Monitoring Dashboard
              </span>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
                WhatsApp live monitoring, not just session control
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
                Track connected employees, watch live customer chats, inspect response behavior, and keep the entire support operation visible in realtime.
              </p>
            </div>

            <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2 xl:min-w-[420px]">
              <div className="rounded-2xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                <div className="text-slate-400">Socket</div>
                <div className="mt-1 font-medium text-white">{socketReady ? "Connected" : "Waiting"}</div>
              </div>
              <div className="rounded-2xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                <div className="text-slate-400">Backend</div>
                <div className="mt-1 font-medium text-white mono break-all">{BACKEND_URL}</div>
              </div>
            </div>
          </div>
        </section>

        {error ? (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <section className="glass-panel rounded-[1.75rem] p-4 sm:p-5">
          <div className="grid gap-3 xl:grid-cols-[1.6fr_0.75fr_0.75fr_auto]">
            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">Search</span>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Customer number or message text"
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              />
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">Employee</span>
              <select
                value={drilldownSessionName ?? ""}
                onChange={(event) => setDrilldownSessionName(event.target.value || null)}
                className="w-full bg-transparent text-sm text-white outline-none"
              >
                <option value="">All employees</option>
                {employees.map((employee) => (
                  <option key={employee.session_name} value={employee.session_name}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">Chat</span>
              <select
                value={chatFilter}
                onChange={(event) => setChatFilter(event.target.value as typeof chatFilter)}
                className="w-full bg-transparent text-sm text-white outline-none"
              >
                <option value="all">All chats</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
                <option value="unanswered">Unanswered only</option>
              </select>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setChatFilter("all");
                  setDrilldownSessionName(null);
                }}
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/10"
              >
                Clear filters
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            title="Total Messages Today"
            value={scopedAnalytics.totalMessagesToday}
            description="All captured inbound and outbound messages for the current day."
            accent="bg-cyan-400/20 shadow-[0_0_0_1px_rgba(34,211,238,0.1)]"
          />
          <MetricCard
            title="Average Response Time"
            value={formatResponseTime(scopedAnalytics.averageResponseTimeMinutes)}
            description="Average time from incoming customer message to employee reply."
            accent="bg-emerald-400/20 shadow-[0_0_0_1px_rgba(52,211,153,0.1)]"
          />
          <MetricCard
            title="Active Employees"
            value={scopedAnalytics.activeEmployees}
            description="Connected employees with recent activity in the last 15 minutes."
            accent="bg-amber-400/20 shadow-[0_0_0_1px_rgba(251,191,36,0.1)]"
          />
          <MetricCard
            title="Unanswered Chats"
            value={scopedAnalytics.unansweredChats}
            description="Customer conversations whose latest message is still unanswered."
            accent="bg-rose-400/20 shadow-[0_0_0_1px_rgba(244,63,94,0.1)]"
          />
          <MetricCard
            title="Most Active Employee"
            value={filteredMostActiveEmployee?.employee_name ?? "—"}
            description={
              filteredMostActiveEmployee
                ? `${filteredMostActiveEmployee.total_messages_today} messages today`
                : "No activity yet"
            }
            accent="bg-violet-400/20 shadow-[0_0_0_1px_rgba(167,139,250,0.1)]"
          />
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.85fr)]">
          <div className="flex flex-col gap-6">
            <div className="glass-panel overflow-hidden rounded-[2rem]">
              <SectionHeader
                title="Employee Operations"
                description="Connect or disconnect employee sessions without losing LocalAuth persistence. Status updates, activity, and messaging stats update in realtime."
                meta={loading ? "Loading data..." : `${employees.length} employees`}
              />

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-white/8">
                  <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.2em] text-slate-400">
                    <tr>
                      <th className="px-5 py-4 font-medium sm:px-6">Employee</th>
                      <th className="px-5 py-4 font-medium">Status</th>
                      <th className="px-5 py-4 font-medium">Today</th>
                      <th className="px-5 py-4 font-medium">Activity</th>
                      <th className="px-5 py-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8">
                    {employees.map((employee) => {
                      const status = employee.connected
                        ? { label: "Connected", tone: "success" as const }
                        : employee.runtime_status === "connecting" || employee.runtime_status === "qr"
                          ? { label: "Connecting", tone: "warning" as const }
                          : employee.runtime_status === "error"
                            ? { label: "Error", tone: "danger" as const }
                            : { label: "Offline", tone: "muted" as const };
                      const isBusy = savingSession === employee.session_name;
                      const isDrilldownSelected = drilldownSessionName === employee.session_name;
                      const isActive = Boolean(
                        employee.last_active && now - new Date(employee.last_active).getTime() <= 15 * 60 * 1000,
                      );

                      return (
                        <tr
                          key={employee.id}
                          onClick={() => setDrilldownSessionName(employee.session_name)}
                          className={`cursor-pointer bg-white/[0.02] transition hover:bg-white/[0.04] ${
                            isDrilldownSelected ? "bg-cyan-400/10 ring-1 ring-cyan-400/30" : ""
                          }`}
                        >
                          <td className="px-5 py-5 sm:px-6">
                            <div className="font-medium text-white">{employee.name}</div>
                            <div className="mt-1 text-sm text-slate-400 mono">{employee.session_name}</div>
                            <div className="mt-2 text-xs text-slate-500">{employee.recent_customer ? `Customer: ${shortSender(employee.recent_customer)}` : "No live conversation"}</div>
                          </td>
                          <td className="px-5 py-5">
                            <div className="flex flex-col gap-2">
                              <StatusPill tone={status.tone}>{status.label}</StatusPill>
                              <div className="flex items-center gap-2 text-xs text-slate-400">
                                <span className={`h-2 w-2 rounded-full ${isActive ? "bg-emerald-300 shadow-[0_0_0_4px_rgba(52,211,153,0.12)]" : "bg-slate-500"}`} />
                                {isActive ? "Active now" : formatRelative(employee.last_active, now)}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-5 text-sm text-slate-200">
                            <div className="font-medium text-white">{employee.today_message_count ?? employee.total_messages}</div>
                            <div className="mt-1 text-xs text-slate-400">messages today</div>
                          </td>
                          <td className="px-5 py-5 text-sm text-slate-300">
                            <div className="max-w-[240px]">
                              <div className="truncate text-slate-100">
                                {employee.recent_message || "No recent customer message"}
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {employee.recent_message_at ? formatTimestamp(employee.recent_message_at) : formatRelative(employee.last_active, now)}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-5 text-right">
                            <div className="inline-flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setActiveSessionName(employee.session_name);
                                  setQrDataUrl(employee.qr_data_url ?? null);
                                  void updateSession("connect", employee.session_name);
                                }}
                                disabled={isBusy || employee.connected}
                                className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {employee.connected ? "Connected" : isBusy ? "Starting..." : "Connect"}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDrilldownSessionName(employee.session_name);
                                }}
                                className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/15"
                              >
                                Inspect
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void updateSession("disconnect", employee.session_name);
                                }}
                                disabled={isBusy || !employee.connected}
                                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Disconnect
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {!loading && employees.length === 0 ? (
                      <tr>
                        <td className="px-5 py-10 text-center text-sm text-slate-400" colSpan={5}>
                          No employee rows found in Supabase.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass-panel overflow-hidden rounded-[2rem]">
              <SectionHeader
                title="Recent Messages"
                description="All captured WhatsApp messages, newest first. This table powers the live chat feed and response analytics."
                meta={`${tableMessages.length} shown`}
              />

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-white/8">
                  <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.2em] text-slate-400">
                    <tr>
                      <th className="px-5 py-4 font-medium sm:px-6">Time</th>
                      <th className="px-5 py-4 font-medium">Employee</th>
                      <th className="px-5 py-4 font-medium">Customer</th>
                      <th className="px-5 py-4 font-medium">Direction</th>
                      <th className="px-5 py-4 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8">
                    {tableMessages.map((message) => {
                      const employeeName =
                        message.employee_name ||
                        employees.find((employee) => employee.session_name === message.employee_session)?.name ||
                        message.employee_session;

                      return (
                        <tr key={message.id} className="bg-white/[0.02] transition hover:bg-white/[0.04]">
                          <td className="px-5 py-4 text-sm text-slate-300 sm:px-6">
                            {formatClock(message.timestamp ?? message.created_at)}
                          </td>
                          <td className="px-5 py-4 text-sm text-white">{employeeName}</td>
                          <td className="px-5 py-4 text-sm text-slate-300 mono">{shortSender(message.sender)}</td>
                          <td className="px-5 py-4">
                            <StatusPill tone={message.from_me ? "success" : "info"}>
                              {message.from_me ? "Outgoing" : "Incoming"}
                            </StatusPill>
                          </td>
                          <td className="px-5 py-4 text-sm text-slate-200">
                            <div className="max-w-[28rem] truncate">{message.message}</div>
                          </td>
                        </tr>
                      );
                    })}

                    {!loading && tableMessages.length === 0 ? (
                      <tr>
                        <td className="px-5 py-10 text-center text-sm text-slate-400" colSpan={5}>
                          No messages captured yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass-panel rounded-[2rem] p-5 sm:p-6">
              <div className="flex flex-col gap-2 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">
                    Response Analytics
                    {drilldownSessionName ? ` · ${selectedDrilldownEmployee?.name ?? drilldownSessionName}` : ""}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-400">
                    Message volume by employee. This helps identify who is handling the most load right now.
                  </p>
                </div>
                <StatusPill tone="info">Today only</StatusPill>
              </div>

              <div className="mt-5 grid gap-4">
                {scopedAnalytics.messagesPerEmployee.length > 0 ? (
                  scopedAnalytics.messagesPerEmployee.map((entry) => (
                    <BarRow
                      key={entry.session_name}
                      label={entry.employee_name}
                      value={entry.total_messages_today}
                      maxValue={Math.max(1, ...scopedAnalytics.messagesPerEmployee.map((item) => item.total_messages_today))}
                    />
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-sm text-slate-400">
                    No message volume data yet.
                  </div>
                )}
              </div>

              <div className="mt-6 rounded-[1.35rem] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Messages per hour</div>
                    <div className="text-xs text-slate-500">Traffic distribution for the current view.</div>
                  </div>
                  <StatusPill tone="info">{scopedAnalytics.messagesPerHour.length} buckets</StatusPill>
                </div>

                <div className="mt-4 grid gap-3">
                  {scopedAnalytics.messagesPerHour.length > 0 ? (
                    scopedAnalytics.messagesPerHour.map((bucket) => (
                      <div key={bucket.hour} className="space-y-2">
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-slate-200">{bucket.hour}</span>
                          <span className="mono text-slate-400">{bucket.count}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-white/6">
                          <div
                            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(103,167,255,0.95),rgba(97,242,182,0.95))]"
                            style={{ width: `${Math.max(8, (bucket.count / Math.max(1, ...scopedAnalytics.messagesPerHour.map((item) => item.count))) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                      No hourly traffic yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="glass-panel sticky top-6 overflow-hidden rounded-[2rem]">
              <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
                <div>
                  <h2 className="text-xl font-semibold text-white">Operations Panel</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-400">
                    Realtime live feed, employee drilldown, smart alerts, and active chat monitoring.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={socketReady ? "success" : "warning"}>
                    {socketReady ? "Realtime active" : "Waiting"}
                  </StatusPill>
                  <button
                    type="button"
                    onClick={() => setDrilldownCollapsed((value) => !value)}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10"
                  >
                    {drilldownCollapsed ? "Expand" : "Collapse"}
                  </button>
                </div>
              </div>

              {!drilldownCollapsed ? (
                <div className="space-y-5 px-4 py-4 sm:px-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/8">
                      <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Scope</div>
                      <div className="mt-2 text-lg font-semibold text-white">
                        {selectedDrilldownEmployee?.name ?? "All employees"}
                      </div>
                      <div className="mt-2 text-sm text-slate-400">
                        {normalizedSearch ? `Search: ${searchQuery}` : "No text search active"}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/8">
                      <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Alerts</div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="text-3xl font-semibold text-white">{scopedAlerts.length}</div>
                        <StatusPill tone={scopedAlerts.length > 0 ? "warning" : "success"}>
                          {scopedAlerts.length > 0 ? "Attention" : "Clear"}
                        </StatusPill>
                      </div>
                    </div>
                  </div>

                  {selectedDrilldownEmployee ? (
                    <div className="rounded-[1.35rem] border border-cyan-400/15 bg-cyan-400/10 p-4 ring-1 ring-cyan-400/10">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-xs uppercase tracking-[0.24em] text-cyan-200/80">Employee Drilldown</div>
                          <div className="mt-1 text-xl font-semibold text-white">{selectedDrilldownEmployee.name}</div>
                          <div className="mt-1 text-sm text-cyan-100/80 mono">{selectedDrilldownEmployee.session_name}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setDrilldownSessionName(null)}
                          className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-400/15"
                        >
                          Clear
                        </button>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="rounded-2xl bg-slate-950/40 px-4 py-3">
                          <div className="text-xs text-slate-500">Total chats</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{scopedAnalytics.totalChatsToday}</div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/40 px-4 py-3">
                          <div className="text-xs text-slate-500">Messages</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{scopedAnalytics.totalMessagesToday}</div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/40 px-4 py-3">
                          <div className="text-xs text-slate-500">Active chats</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{scopedAnalytics.activeChatsCount}</div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/40 px-4 py-3">
                          <div className="text-xs text-slate-500">Unanswered</div>
                          <div className="mt-1 text-2xl font-semibold text-white">{scopedAnalytics.unansweredChats}</div>
                        </div>
                        <div className="rounded-2xl bg-slate-950/40 px-4 py-3">
                          <div className="text-xs text-slate-500">Response time</div>
                          <div className="mt-1 text-2xl font-semibold text-white">
                            {formatResponseTime(scopedAnalytics.averageResponseTimeMinutes)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">Smart Alerts</div>
                        <div className="text-xs text-slate-500">Risk and backlog signals for managers.</div>
                      </div>
                      <StatusPill tone={scopedAlerts.length > 0 ? "warning" : "success"}>
                        {scopedAlerts.length} alerts
                      </StatusPill>
                    </div>

                    <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                      {scopedAlerts.slice(0, 6).map((alert, index) => (
                        <div key={`${alert.type}-${alert.timestamp ?? index}`} className="rounded-2xl bg-black/20 px-4 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium text-white">{alert.title ?? alert.type}</div>
                            <StatusPill tone={alert.severity === "high" ? "danger" : "warning"}>
                              {alert.severity}
                            </StatusPill>
                          </div>
                          <div className="mt-1 text-xs text-slate-400">{alert.description ?? alert.message ?? "Alert triggered"}</div>
                        </div>
                      ))}
                      {scopedAlerts.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-slate-400">
                          No active alerts for this view.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">Active Chats</div>
                        <div className="text-xs text-slate-500">Open or recently active conversations.</div>
                      </div>
                      <StatusPill tone="info">{activeChats.length}</StatusPill>
                    </div>

                    <div className="mt-3 space-y-2">
                      {activeChats.map((conversation) => (
                        <div key={conversation.key} className="rounded-2xl bg-black/20 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-white">{conversation.employee_name}</div>
                              <div className="mt-1 text-xs text-slate-500 mono">{shortSender(conversation.sender)}</div>
                            </div>
                            <StatusPill tone={conversation.unanswered ? "warning" : "info"}>
                              {conversation.unanswered ? "Waiting" : "Active"}
                            </StatusPill>
                          </div>
                          <div className="mt-2 text-sm text-slate-300">{conversation.latestMessage}</div>
                        </div>
                      ))}
                      {activeChats.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-slate-400">
                          No active chats in the current scope.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <SectionHeader
                      title="Live Chat Feed"
                      description="Realtime inbound and outbound chat stream. New WhatsApp messages appear here as they are captured."
                      meta={socketReady ? <StatusPill tone="success">Realtime active</StatusPill> : <StatusPill tone="warning">Waiting for socket</StatusPill>}
                    />

                    <div className="max-h-[760px] overflow-y-auto px-1 py-4">
                      <div className="space-y-3">
                        {liveMessages.map((message) => {
                          const employeeName =
                            message.employee_name ||
                            employees.find((employee) => employee.session_name === message.employee_session)?.name ||
                            message.employee_session;

                          return (
                            <div
                              key={message.id}
                              className="rounded-[1.4rem] border border-white/8 bg-white/[0.03] p-4 ring-1 ring-white/5"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <div className="text-base font-semibold text-white">{employeeName}</div>
                                  <div className="mt-1 text-sm text-slate-400 mono">Customer: {shortSender(message.sender)}</div>
                                </div>
                                <StatusPill tone={message.from_me ? "success" : "info"}>
                                  {message.from_me ? "Outgoing" : "Incoming"}
                                </StatusPill>
                              </div>

                              <div className="mt-4 space-y-2">
                                <MessageBubble message={message} employeeName={employeeName} />
                              </div>
                            </div>
                          );
                        })}

                        {!loading && liveMessages.length === 0 ? (
                          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-sm text-slate-400">
                            Live feed will populate as soon as WhatsApp messages start arriving.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="px-5 py-6 text-sm text-slate-400">Panel collapsed. Expand to inspect alerts and live messages.</div>
              )}
            </div>
          </div>
        </section>

        <section className="glass-panel overflow-hidden rounded-[2rem]">
          <SectionHeader
            title="Activity Timeline"
            description="A compact chronological log of the latest customer and employee activity across the dashboard."
            meta={`${scopedAnalytics.activityTimeline.length} events`}
          />

          <div className="grid gap-4 px-5 py-5 sm:px-6 lg:grid-cols-2 xl:grid-cols-4">
            {scopedAnalytics.activityTimeline.map((item) => (
              <div
                key={`${item.session_name}-${item.sender}-${item.timestamp}`}
                className="rounded-[1.35rem] border border-white/8 bg-white/[0.03] p-4 ring-1 ring-white/5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-white">{item.employee_name}</div>
                  <StatusPill tone={item.from_me ? "success" : "info"}>{item.from_me ? "Outgoing" : "Incoming"}</StatusPill>
                </div>
                <div className="mt-2 text-xs text-slate-500 mono">{shortSender(item.sender)}</div>
                <div className="mt-3 text-sm leading-6 text-slate-200">{item.message}</div>
                <div className="mt-3 text-xs text-slate-500">{formatTimestamp(item.timestamp)}</div>
              </div>
            ))}

            {!loading && scopedAnalytics.activityTimeline.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-sm text-slate-400">
                Timeline will populate with message and activity events.
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {selectedEmployee ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
          <div className="glass-panel w-full max-w-xl rounded-[2rem] p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">QR Onboarding</div>
                <h3 className="mt-2 text-2xl font-semibold text-white">{selectedEmployee.name}</h3>
                <p className="mt-2 text-sm text-slate-400 mono">{selectedEmployee.session_name}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveSessionName(null);
                  setQrDataUrl(null);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10"
              >
                Close
              </button>
            </div>

            <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-slate-950/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <StatusPill tone={modalTone}>
                  {selectedEmployee.connected
                    ? "Connected"
                    : selectedEmployee.runtime_status === "qr" || selectedEmployee.runtime_status === "connecting"
                      ? "Waiting for scan"
                      : selectedEmployee.runtime_status === "error"
                        ? "Error"
                        : "Offline"}
                </StatusPill>
                <div className="text-xs text-slate-400">
                  {selectedEmployee.connected ? "Session live" : "Scan once to finish onboarding"}
                </div>
              </div>

              <div className="mt-5 flex min-h-[18rem] items-center justify-center rounded-[1.25rem] border border-dashed border-white/10 bg-[radial-gradient(circle_at_top,rgba(103,167,255,0.14),rgba(7,18,31,0.85))] p-4">
                {modalQrDataUrl ? (
                  <Image
                    src={modalQrDataUrl}
                    alt="WhatsApp QR code"
                    width={288}
                    height={288}
                    unoptimized
                    className="h-72 w-72 rounded-2xl bg-white p-3 shadow-2xl shadow-black/30"
                  />
                ) : selectedEmployee.connected ? (
                  <div className="text-center">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/20">
                      OK
                    </div>
                    <p className="mt-4 text-lg font-medium text-white">Connected successfully</p>
                    <p className="mt-2 text-sm text-slate-400">The dashboard and monitoring panels have already updated in realtime.</p>
                  </div>
                ) : (
                  <div className="max-w-sm text-center">
                    <div className="mx-auto h-12 w-12 animate-pulse rounded-full bg-cyan-400/20 ring-1 ring-cyan-300/20" />
                    <p className="mt-4 text-lg font-medium text-white">Preparing QR code</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                      Keep this modal open. As soon as the backend emits the QR, it will appear here automatically.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
