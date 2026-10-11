# ============================================================================
# 智愿 · 高考志愿填报（云端版）—— Docker 镜像
# 部署平台：Render（Web Service / Docker），亦可跑 Hugging Face Spaces
#
# 说明：
#   · 基础镜像用 node:lts-alpine，体积小、启动快
#   · 本项目用 Node 自带的 node:sqlite，**不需要任何原生编译**
#   · 必须用 lts（= Node 22+）：node:sqlite 从 Node v22.5.0 才开始提供
#   · 端口由平台注入的 PORT 决定（Render 默认 10000，HF Spaces 默认 7860）
# ============================================================================
FROM node:lts-alpine

# ---- 运行环境：字符集与时区 ----
# ⚠️ Alpine 基础镜像**不含 tzdata**：缺它时 OS 层 localtime 会退回 UTC
#    （影响 SQLite 的 datetime('now','localtime')），Node/ICU 也不会采纳 TZ。
#    必须在 ENV TZ 之前装好。
RUN apk add --no-cache tzdata

# 不设这些变量时：容器为 UTC，server.js 里的本地时间会与北京时间差 8 小时。
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

# 工作目录（容器里的 /app 就是项目根）
WORKDIR /app

# ---- 依赖层（单独一层，改代码时不必重装依赖，构建更快）----
# 先只拷 package.json；npm install 之后这些层会被缓存
COPY package.json ./
# 用 --omit=dev 跳过开发依赖；--no-audit --no-fund 少打点日志
RUN npm install --omit=dev --no-audit --no-fund

# ---- 应用代码 ----
COPY server.js  ./
COPY index.html ./

# D 域（家庭协同）新增目录 —— 只增式挂载，必须随镜像一起带进容器
COPY routes-d/  ./routes-d/
COPY services/  ./services/
COPY repo/      ./repo/

# 种子库：仓库里这份是「初始种子」，不是运行库。
# 容器内仍落在 /app/gkzy.db（与 server.js 的 DB_FILE 一致），行为与从前完全相同；
# 但仓库里不再出现一个看起来像「活库」的 gkzy.db。
# ⚠️ 注意：容器文件系统是临时的，运行期写入在重启/重新部署后会回退到这份种子。
#    真正的持久化在迭代方案的阶段 2（外部 Postgres）解决。
COPY seed/gkzy.seed.db ./gkzy.db

# 建库脚本也一并带上：容器首次启动若发现数据库不可用，server.js 会自动执行它们
COPY init_db.js  ./
COPY init_v2.js  ./

# 以 UID 1000 的非 root 用户运行容器，
# 提前把 /app 的属主改成 node 用户，保证 SQLite 有写权限
RUN chown -R node:node /app
USER node

# 对外暴露端口（实际以平台注入的 PORT 为准）
EXPOSE 10000

# 健康检查：每 30 秒打一次 /api/health，容器被平台重启前能先发现问题
# 端口读环境变量，避免写死端口导致探活永远失败（那会掩盖真实故障）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动（与 package.json 的 start 脚本一致）
CMD ["node", "server.js"]
