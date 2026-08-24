-- Public invoker wrapper needs authenticated EXECUTE on its unexposed private helper.
grant execute on function private.get_live_cutover_status() to authenticated;
