-- The sync_runs update trigger calls touch_updated_at(), which writes
-- NEW.updated_at. The original sync_runs table was missing that column.
-- Add it before ensuring the trigger exists so finishing syncs no longer fail.
alter table public.sync_runs
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_sync_runs_touch on public.sync_runs;
create trigger trg_sync_runs_touch
  before update on public.sync_runs
  for each row execute function public.touch_updated_at();
