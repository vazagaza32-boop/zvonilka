# Официальный Node-образ (LTS)
FROM node:20-alpine

WORKDIR /app

# Копируем всё (зависимостей нет — чистый Node)
COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./

ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Хостинг задаёт PORT автоматически
EXPOSE 3000

CMD ["node", "server.js"]
