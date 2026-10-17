/* ============================================================================
 * sql/13_users.sql —— 用户账户与会话（保存「用户数据」的安放点）
 * ---------------------------------------------------------------------------
 * 幂等：整份文件可被服务端一次性执行任意次（create table if not exists /
 * create index if not exists）。用户无需手动去 Supabase SQL Editor 敲 SQL，
 * 由 services/auth.js 的 ensureSchema() 在首次用到时通过 pg.query(整段SQL) 执行。
 * 若表/索引已存在，重复执行零副作用。
 *
 * 设计定位（详见 deliverables/product-strategy/spec-user-data-architecture）：
 *   · 这是「未来一切用户数据」的统一挂靠根表 —— app_users(id) 是所有带 user_id
 *     的表（volunteers / family_message / consensus_* / 后续新表）的外键根。
 *   · 当前阶段「只落地架构、不迁移既有数据、不强制真实注册」：本文件只建表 +
 *     保证 demo 账号有安放位置，游客数据仍走本地存储，后续升级脚本再并入账号。
 *
 * 安全模型（与 12_consensus.sql 一致）：所有用户表启用 RLS，并撤销
 *   anon/authenticated 的全部权限（表 owner / 服务角色不在撤销之列，
 *   应用层仍按 user_id 做行级隔离）。
 * ========================================================================== */

/* ---------- 1. app_users —— 账户根表（所有用户数据的挂靠点） ---------- */
create table if not exists public.app_users (
  id                serial                     primary key,
  username          text                       unique not null,
  password_hash     text                       not null,
  display_name      text                       not null default '',
  role              text                       not null default 'student'
                    check (role in ('student','parent','teacher')),
  is_virtual        boolean                    not null default false,
  created_at        timestamptz                not null default now()
);
create index if not exists idx_app_users_username on public.app_users (username);

/* ---------- 2. user_sessions —— 登录态（token 即会话凭证） ---------- */
create table if not exists public.user_sessions (
  token             text                       primary key,
  user_id           integer                    not null
                    references public.app_users(id) on delete cascade,
  created_at        timestamptz                not null default now(),
  expires_at        timestamptz                not null
);
create index if not exists idx_user_sessions_user    on public.user_sessions (user_id);
create index if not exists idx_user_sessions_expires on public.user_sessions (expires_at);

/* ---------- 逐张：启用 RLS + 撤销匿名/认证角色全部权限（幂等） ----------
 * ★ 与 12_consensus.sql 同样理由用 DO 块守卫角色是否存在：
 *   pg 的 simple query 协议下整份文件是**一个隐式事务**——里面任何一条语句报错，
 *   前面已建好的表会被一起回滚。而裸 PG（本地 e2e、自建实例、未建角色的新项目）
 *   里没有 anon / authenticated，直接 revoke 必报错，ensureSchema() 就永远建不出表。
 *   守卫后：角色存在才撤销，不存在就跳过 —— 建表一定成功。 */
alter table public.app_users    enable row level security;
alter table public.user_sessions enable row level security;

do $$
declare
  r text;
  t text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array['app_users','user_sessions'] loop
        execute format('revoke all on public.%I from %I', t, r);
      end loop;
    end if;
  end loop;
end $$;

/* ---------- 只读自检（Supabase SQL Editor 只显示最后一个结果集） ---------- */
select 'user tables' as self_check, count(*) as n
from information_schema.tables
where table_schema = 'public'
  and table_name in ('app_users','user_sessions');
