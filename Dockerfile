# 深海采集站 · 故障闭环审计页
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 零第三方依赖：直接拷贝源码即可构建运行
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY test ./test

# 构建：语法检查 + 装配 public/ + 引用校验
RUN node scripts/build.js

# 端口可调：PORT 环境变量（Compose 中由 APP_PORT 注入）
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "src/server.js"]
