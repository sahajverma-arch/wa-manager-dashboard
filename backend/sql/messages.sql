create table if not exists messages (
  id uuid default gen_random_uuid() primary key,
  employee_session text,
  sender text,
  message text,
  timestamp timestamp,
  from_me boolean default false,
  created_at timestamp default now()
);

create index if not exists messages_employee_session_idx on messages (employee_session);
create index if not exists messages_created_at_idx on messages (created_at);
