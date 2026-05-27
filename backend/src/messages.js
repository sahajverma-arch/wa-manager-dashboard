function toIsoString(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toMillis(value) {
  const iso = toIsoString(value);
  if (!iso) {
    return null;
  }

  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
}

function startOfDayIso(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function getHourBucket(value) {
  const millis = toMillis(value);
  if (millis === null) {
    return null;
  }

  const date = new Date(millis);
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

function getAngryKeywordMatch(text) {
  const normalized = String(text || "").toLowerCase();
  const keywords = ["refund", "complaint", "bad", "issue"];
  return keywords.find((keyword) => normalized.includes(keyword)) || null;
}

function normalizeMessage(row, employeeName = null) {
  return {
    ...row,
    employee_name: employeeName,
    timestamp: toIsoString(row.timestamp) ?? toIsoString(row.created_at),
    created_at: toIsoString(row.created_at) ?? toIsoString(row.timestamp),
    from_me: Boolean(row.from_me),
  };
}

async function insertMessage(supabase, payload) {
  const insertRow = {
    employee_session: payload.employee_session,
    sender: payload.sender,
    message: payload.message,
    timestamp: payload.timestamp ?? new Date().toISOString(),
    from_me: Boolean(payload.from_me),
  };

  const { data, error } = await supabase
    .from("messages")
    .insert(insertRow)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function fetchMessages(supabase, { sessionName = null, limit = 100 } = {}) {
  let query = supabase
    .from("messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (sessionName) {
    query = query.eq("employee_session", sessionName);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function fetchTodayMessages(supabase, { sessionName = null, now = new Date() } = {}) {
  const since = startOfDayIso(now);
  let query = supabase
    .from("messages")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (sessionName) {
    query = query.eq("employee_session", sessionName);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? [];
}

function buildAnalytics({ employees, messages, now = new Date() }) {
  const employeeBySession = new Map(employees.map((employee) => [employee.session_name, employee]));
  const todayStart = new Date(startOfDayIso(now)).getTime();

  const todayMessages = messages.filter((message) => {
    const messageTime = toMillis(message.timestamp) ?? toMillis(message.created_at);
    return messageTime !== null && messageTime >= todayStart;
  });

  const perEmployee = new Map();
  const perConversation = new Map();
  const latestConversation = new Map();
  const latestEmployeeActivity = new Map();
  const responseTimes = [];
  const messagesPerHourMap = new Map();
  const alerts = [];

  for (const message of todayMessages) {
    const session = message.employee_session;
    const employee = employeeBySession.get(session);
    const sender = message.sender || "unknown";
    const key = `${session}::${sender}`;
    const messageTime = toMillis(message.timestamp) ?? toMillis(message.created_at);

    const hourBucket = getHourBucket(message.timestamp ?? message.created_at);
    if (hourBucket) {
      messagesPerHourMap.set(hourBucket, (messagesPerHourMap.get(hourBucket) ?? 0) + 1);
    }

    if (!perEmployee.has(session)) {
      perEmployee.set(session, { count: 0, employee });
    }

    const employeeBucket = perEmployee.get(session);
    employeeBucket.count += 1;

    latestEmployeeActivity.set(session, {
      session_name: session,
      employee_name: employee?.name ?? session,
      timestamp: message.timestamp ?? message.created_at,
      sender,
      message: message.message,
      from_me: Boolean(message.from_me),
    });

    const conversationState = perConversation.get(key) ?? {
      session_name: session,
      sender,
      lastIncomingAt: null,
      unanswered: false,
    };

    if (message.from_me) {
      if (conversationState.lastIncomingAt !== null && messageTime !== null) {
        responseTimes.push(messageTime - conversationState.lastIncomingAt);
      }
      conversationState.lastIncomingAt = null;
      conversationState.unanswered = false;
    } else {
      conversationState.lastIncomingAt = messageTime;
      conversationState.unanswered = true;
    }

    perConversation.set(key, conversationState);
    latestConversation.set(key, {
      session_name: session,
      sender,
      timestamp: message.timestamp ?? message.created_at,
      message: message.message,
      from_me: Boolean(message.from_me),
    });

    if (!message.from_me) {
      const keyword = getAngryKeywordMatch(message.message);
      if (keyword) {
        alerts.push({
          type: "angry_keyword",
          severity: keyword === "refund" || keyword === "complaint" ? "high" : "medium",
          session_name: session,
          employee_name: employee?.name ?? session,
          sender,
          message: message.message,
          keyword,
          timestamp: message.timestamp ?? message.created_at,
        });
      }
    }
  }

  const connectedEmployees = employees.filter((employee) => employee.connected);
  const activeEmployees = employees.filter((employee) => {
    const lastActive = toMillis(employee.last_active);
    return employee.connected && lastActive !== null && now.getTime() - lastActive <= 15 * 60 * 1000;
  });

  const conversations = Array.from(perConversation.values()).map((conversation) => {
    const lastIncomingAt = conversation.lastIncomingAt;
    const latestAt = lastIncomingAt;
    const minutesSinceLatest =
      latestAt === null ? null : Math.max(0, Math.round((now.getTime() - latestAt) / 60000));

    return {
      ...conversation,
      active: minutesSinceLatest !== null && minutesSinceLatest <= 60,
      stale: conversation.unanswered && minutesSinceLatest !== null && minutesSinceLatest > 30,
      minutes_since_latest: minutesSinceLatest,
    };
  });

  const activeChatsCount = conversations.filter((conversation) => conversation.active).length;
  const totalChatsToday = conversations.length;
  const unansweredChats = conversations.filter((conversation) => conversation.unanswered).length;

  if (unansweredChats >= 5) {
    alerts.push({
      type: "backlog",
      severity: unansweredChats >= 8 ? "high" : "medium",
      title: "Too many unanswered chats",
      description: `${unansweredChats} chats need follow-up`,
    });
  }

  for (const conversation of conversations.filter((conversation) => conversation.stale)) {
    alerts.push({
      type: "stale_reply",
      severity: conversation.minutes_since_latest !== null && conversation.minutes_since_latest >= 60 ? "high" : "medium",
      session_name: conversation.session_name,
      sender: conversation.sender,
      title: "No customer reply in 30+ mins",
      description: `${conversation.sender} is waiting on ${employeeBySession.get(conversation.session_name)?.name ?? conversation.session_name}`,
      timestamp: todayMessages
        .filter(
          (message) =>
            message.employee_session === conversation.session_name &&
            String(message.sender || "") === String(conversation.sender) &&
            !message.from_me,
        )
        .slice(-1)[0]?.timestamp ?? null,
    });
  }

  for (const employee of employees) {
    const lastActive = toMillis(employee.last_active);
    if (!employee.connected || lastActive === null) {
      continue;
    }

    const minutesInactive = Math.max(0, Math.round((now.getTime() - lastActive) / 60000));
    if (minutesInactive >= 45) {
      alerts.push({
        type: "employee_inactive",
        severity: minutesInactive >= 120 ? "high" : "medium",
        session_name: employee.session_name,
        employee_name: employee.name,
        title: "Employee inactive",
        description: `${employee.name} has been inactive for ${minutesInactive} minutes`,
        timestamp: employee.last_active,
      });
    }
  }

  const messagesPerEmployee = employees
    .map((employee) => ({
      session_name: employee.session_name,
      employee_name: employee.name,
      total_messages_today: perEmployee.get(employee.session_name)?.count ?? 0,
      active_chats: conversations.filter((conversation) => conversation.session_name === employee.session_name && conversation.active).length,
    }))
    .sort((a, b) => b.total_messages_today - a.total_messages_today);

  const mostActiveEmployee = messagesPerEmployee[0] ?? null;
  const averageResponseTimeMinutes =
    responseTimes.length > 0
      ? Math.round((responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length / 60000) * 10) / 10
      : 0;

  const messagesPerHour = Array.from(messagesPerHourMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, count]) => ({ hour, count }));

  const lastEmployeeActivity = Array.from(latestEmployeeActivity.values())
    .sort((a, b) => {
      const aTime = toMillis(a.timestamp) ?? 0;
      const bTime = toMillis(b.timestamp) ?? 0;
      return bTime - aTime;
    })
    .slice(0, 8);

  const activityTimeline = Array.from(latestConversation.values())
    .sort((a, b) => {
      const aTime = toMillis(a.timestamp) ?? 0;
      const bTime = toMillis(b.timestamp) ?? 0;
      return bTime - aTime;
    })
    .slice(0, 12);

  return {
    totalMessagesToday: todayMessages.length,
    totalChatsToday,
    activeChatsCount,
    averageResponseTimeMinutes,
    activeEmployees: activeEmployees.length,
    connectedEmployees: connectedEmployees.length,
    unansweredChats,
    mostActiveEmployee,
    messagesPerEmployee,
    messagesPerHour,
    alerts: alerts
      .sort((a, b) => {
        const severityRank = { high: 2, medium: 1, low: 0 };
        return (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
      })
      .slice(0, 20),
    lastEmployeeActivity,
    activityTimeline,
  };
}

module.exports = {
  buildAnalytics,
  fetchMessages,
  fetchTodayMessages,
  insertMessage,
  normalizeMessage,
  startOfDayIso,
  toIsoString,
};
