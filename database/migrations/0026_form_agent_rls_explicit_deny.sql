-- Milestone 10 security polish: make the intentional no-direct-access boundary explicit to the advisor.
-- The local companion talks only through the scoped Edge bridge; service_role bypasses RLS server-side.

create policy form_agent_sessions_no_direct_authenticated_access
on public.form_agent_sessions
for all to authenticated
using (false)
with check (false);

create policy form_agent_observations_no_direct_authenticated_access
on public.form_agent_observations
for all to authenticated
using (false)
with check (false);

create policy form_agent_plans_no_direct_authenticated_access
on public.form_agent_plans
for all to authenticated
using (false)
with check (false);
