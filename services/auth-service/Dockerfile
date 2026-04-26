# Multi-stage is overkill for a dev image; single stage is fine here.
# We use node:20-alpine for a small footprint.
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package files FIRST — Docker caches this layer.
# If only source code changes (not dependencies), npm install won't re-run.
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the rest of the source code
COPY . .

# Expose the port this service listens on
EXPOSE 4001

# Start the service
CMD ["node", "index.js"]
