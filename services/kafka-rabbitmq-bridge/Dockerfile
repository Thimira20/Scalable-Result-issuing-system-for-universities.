FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# No EXPOSE — this is a background worker, no HTTP server
CMD ["node", "index.js"]
