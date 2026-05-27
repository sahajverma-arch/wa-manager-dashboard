function enrichEmployee(row, runtimeState = {}, activityState = {}) {
  const connected = Boolean(row.connected || runtimeState.connected);
  const runtimeStatus = runtimeState.status ?? (connected ? "ready" : "offline");
  const qrDataUrl = runtimeState.qrDataUrl ?? null;
  const lastActive = activityState.last_active ?? row.last_active ?? null;

  return {
    ...row,
    connected,
    runtime_status: runtimeStatus,
    qr_data_url: qrDataUrl,
    last_active: lastActive,
    recent_message: activityState.recent_message ?? null,
    recent_customer: activityState.recent_customer ?? null,
    recent_message_at: activityState.recent_message_at ?? null,
    today_message_count: activityState.today_message_count ?? (Number(row.total_messages) || 0),
  };
}

async function fetchEmployees(supabase) {
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function fetchEmployeeBySession(supabase, sessionName) {
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .eq("session_name", sessionName)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function setEmployeeConnected(supabase, sessionName, connected) {
  const updateRow = { connected };
  if (connected) {
    updateRow.last_active = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("employees")
    .update(updateRow)
    .eq("session_name", sessionName)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function incrementMessageCount(supabase, sessionName) {
  const employee = await fetchEmployeeBySession(supabase, sessionName);

  if (!employee) {
    return null;
  }

  const nextCount = (Number(employee.total_messages) || 0) + 1;
  const lastActive = new Date().toISOString();

  const { data, error } = await supabase
    .from("employees")
    .update({
      total_messages: nextCount,
      last_active: lastActive,
      connected: true,
    })
    .eq("session_name", sessionName)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function seedEmployeesIfNeeded(supabase, seeds) {
  const { count, error } = await supabase
    .from("employees")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw error;
  }

  if ((count ?? 0) > 0) {
    return false;
  }

  const { error: seedError } = await supabase.from("employees").insert(seeds);

  if (seedError) {
    throw seedError;
  }

  return true;
}

module.exports = {
  enrichEmployee,
  fetchEmployeeBySession,
  fetchEmployees,
  incrementMessageCount,
  seedEmployeesIfNeeded,
  setEmployeeConnected,
};
