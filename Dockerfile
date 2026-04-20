FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY card_engine/requirements.txt ./card_engine/
RUN pip3 install --no-cache-dir --break-system-packages -r card_engine/requirements.txt

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "export PORT=${PORT:-8000}; exec node server.js"]
