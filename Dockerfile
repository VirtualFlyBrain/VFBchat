FROM node:22-alpine

WORKDIR /app

# The governed log layers. Owned by the unprivileged user the service runs as,
# and readable only by that user: raw security logs contain IP addresses, so
# access to them is enforced by the filesystem rather than only by operational
# convention.
RUN mkdir -p /logs/security /logs/analytics /logs/feedback \
    && chown -R node:node /logs \
    && chmod -R 0700 /logs

COPY package*.json ./

RUN npm ci --omit=dev --ignore-scripts || npm install

COPY . .

RUN npm run build \
    && chown -R node:node /app

# Nothing after this point runs as root.
USER node

EXPOSE 3000

CMD ["npm", "start"]
