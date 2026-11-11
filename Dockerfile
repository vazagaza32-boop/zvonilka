# Официальный Node-образ (LTS)
FROM node:20-alpine

WORKDIR /app

# Зависимостей нет, но тогда при появлении package-lock всё подхватится
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

# Код
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Render задаёт PORT автоматически
EXPOSE 3000

CMD ["node", "server.js"]
