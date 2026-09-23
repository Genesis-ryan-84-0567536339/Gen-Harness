FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY apps/bridge/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY apps/bridge/src ./src
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
