# ============================================================================
# 智愿 · 高考志愿填报（云端版）—— Docker 镜像
# 适用：Hugging Face Spaces（Docker SDK）/ 任意容器平台
#
# 说明：
#   · 基础镜像用 node:lts-alpine，体积小、启动快
#   · 本项目用 Node 自带的 node:sqlite，**不需要任何原生编译**
#     （所以不需要装 python / make / g++ 这些构建工具，alpine 也够用）
#   · 必须用 lts（= Node 22+）：node:sqlite 从 Node v22.5.0 才开始提供
#   · 端口 7860 是 Hugging Face Spaces 的默认对外端口
# ============================================================================
FROM node:lts-alpine

# 工作目录（容器里的 /app 就是你的项目根）
WORKDIR /app

# ---- 依赖层（单独一层，改代码时不必重装依赖，构建更快）----
# 先只拷 package.json；npm install 之后这些层会被缓存
COPY package.json ./
# 用 --omit=dev 跳过开发依赖；--no-audit --no-fund 少打点日志
RUN npm install --omit=dev --no-audit --no-fund

# ---- 应用代码 ----
COPY server.js  ./
COPY index.html ./
COPY gkzy.db    ./
# 建库脚本也一并带上：容器首次启动若发现数据库不可用，server.js 会自动执行它们
COPY init_db.js  ./
COPY init_v2.js  ./

# HF Spaces 会以 UID 1000 的非 root 用户运行容器，
# 这里提前把 /app 的属主改成 node 用户，保证 SQLite 有写权限
RUN chown -R node:node /app
USER node

# 对外暴露 7860（HF Spaces 约定）
EXPOSE 7860

# 健康检查：每 30 秒打一次 /api/health，容器自动重启前能先发现问题
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动（与 package.json 的 start 脚本一致）
CMD ["node", "server.js"]
