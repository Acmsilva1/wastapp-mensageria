begin;
do $$ begin
  if exists(select 1 from mensageria.recipients where deleted_at is not null) then
    raise exception 'Existem contatos excluidos; restaure-os explicitamente antes do rollback.';
  end if;
end $$;
alter table mensageria.recipients drop column if exists deleted_at;
commit;
