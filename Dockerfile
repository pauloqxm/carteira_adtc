FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

ENV PORT=8000
EXPOSE 8000

# Mesmo padrão do seu exemplo: usa PORT do ambiente (ex.: Railway) ou 8000.
CMD ["sh", "-c", "export PORT=${PORT:-8000}; exec node server.js"]
