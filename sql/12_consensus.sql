/* ============================================================================
 * sql/12_consensus.sql —— D 域（家庭协同）家长三态表态：共识相关建表
 * ---------------------------------------------------------------------------
 * 幂等：整份文件可被服务端一次性执行任意次（create table if not exists /
 * drop constraint if exists / 索引 if not exists）。
 *
 * 执行方式：services/consensus.js 的 ensureSchema() 在首次用到时通过
 *   pg.query(整段SQL) 执行（simple query 支持多语句、无参数）；
 *   用户无需手动去 Supabase SQL Editor 敲 SQL。
 *   若 TABLE/约束已存在，本文件重复执行零副作用。
 *
 * 安全模型：所有 consensus_* 表启用 RLS，并撤销 anon/authenticated 的全部
 *   权限（表 owner / 服务角色不在撤销之列，应用层仍按 user_id 做行级隔离）。
 * ========================================================================== */

/* ---------- 1. consensus_item —— 共识项（轴 / 院校 / 专业） ---------- */
create table if not exists public.consensus_item (
  id                  bigint generated always as identity primary key,
  user_id             bigint        not null,
  room_id             text          not null,
  item_type           text          not null check (item_type in ('axis','college','major')),
  ref_key             text          not null,
  label               text          not null default '',
  source              text          not null check (source in ('signal','volunteer_divergence')),
  source_message_id   bigint,
  source_raw_version  integer,
  source_role         text          not null default '',
  status              text          not null default 'pending' check (status in ('pending','settled','deferred')),
  condition_text      text          not null default '',
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  unique (user_id, room_id, item_type, ref_key)
);
create index if not exists idx_consensus_item_user_room_status
  on public.consensus_item (user_id, room_id, status);

/* ---------- 2. consensus_stance —— 三态表态（唯一 (item_id, role)） ---------- */
create table if not exists public.consensus_stance (
  id             bigint generated always as identity primary key,
  item_id        bigint        not null references public.consensus_item(id) on delete cascade,
  user_id        bigint        not null,
  role           text          not null check (role in ('student','father','mother','teacher')),
  stance         text          not null check (stance in ('veto','negotiable','accept')),
  reason         text          not null default '',
  substitute     text          not null default '',
  no_substitute  boolean       not null default false,
  condition      text          not null default '',
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (item_id, role)
);
create index if not exists idx_consensus_stance_item on public.consensus_stance (item_id);
create index if not exists idx_consensus_stance_role on public.consensus_stance (role);

/* 禁止裸否决约束（幂等写法：先删后建，重复执行安全） */
alter table public.consensus_stance drop constraint if exists chk_stance_no_naked_veto;
alter table public.consensus_stance add constraint chk_stance_no_naked_veto
  check (stance <> 'veto' or (btrim(reason) <> '' and (btrim(substitute) <> '' or no_substitute)));

/* ---------- 3. consensus_ledger —— 表态软化/让步账本 ---------- */
create table if not exists public.consensus_ledger (
  id          bigint generated always as identity primary key,
  item_id     bigint        not null references public.consensus_item(id) on delete cascade,
  user_id     bigint        not null,
  role        text          not null,
  stance_from text          not null,
  stance_to   text          not null,
  created_at  timestamptz   not null default now()
);

/* ---------- 4. consensus_reveal —— 揭示轮次（本版恒 open，预留） ---------- */
create table if not exists public.consensus_reveal (
  id          bigint generated always as identity primary key,
  user_id     bigint        not null,
  room_id     text          not null,
  round       integer       not null default 1,
  state       text          not null default 'open' check (state in ('open','revealed')),
  revealed_at timestamptz,
  unique (user_id, room_id, round)
);

/* ---------- 5. consensus_final —— 家庭共识书快照 ---------- */
create table if not exists public.consensus_final (
  id           bigint generated always as identity primary key,
  user_id      bigint        not null,
  room_id      text          not null,
  snapshot     jsonb         not null default '{}'::jsonb,
  confirmed_by text[]        not null default '{}',
  scope_text   text          not null default '家庭内部记录，非法律协议',
  confirmed_at timestamptz   not null default now()
);

/* ---------- 逐张：启用 RLS + 撤销匿名/认证角色全部权限（幂等） ----------
 * ★ 为什么用 DO 块守卫角色是否存在：
 *   pg 的 simple query 协议下，整份文件是**一个隐式事务** —— 里面任何一条语句
 *   报错，前面已经建好的表会被一起回滚。而裸 PG（本地 e2e、自建实例、
 *   未建角色的新项目）里根本没有 anon / authenticated，直接 revoke 必报错，
 *   于是 ensureSchema() 永远建不出表、三态表态永远不可用。
 *   守卫后：角色存在才撤销，不存在就跳过 —— 建表一定成功。 */
alter table public.consensus_item    enable row level security;
alter table public.consensus_stance  enable row level security;
alter table public.consensus_ledger  enable row level security;
alter table public.consensus_reveal  enable row level security;
alter table public.consensus_final   enable row level security;

do $$
declare
  r text;
  t text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array['consensus_item','consensus_stance','consensus_ledger',
                               'consensus_reveal','consensus_final'] loop
        execute format('revoke all on public.%I from %I', t, r);
      end loop;
    end if;
  end loop;
end $$;

/* ---------- 只读自检（Supabase SQL Editor 只显示最后一个结果集） ---------- */
select 'consensus tables' as self_check, count(*) as n
from information_schema.tables
where table_schema = 'public'
  and table_name in ('consensus_item','consensus_stance','consensus_ledger','consensus_reveal','consensus_final');
