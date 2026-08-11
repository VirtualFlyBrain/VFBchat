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

# The version this image reports at /api/version, and in the User-Agent it sends
# to the MCP server and every site it fetches.
#
# v4.2.3 shipped with package.json still reading 4.2.2, so the deployment looked
# stale from outside while being entirely correct — an hour was spent chasing a
# pull that had worked. CI passes the release tag in here, which makes the image
# self-describing regardless of whether anyone remembered to bump package.json.
# Empty on a local build, which falls through to package.json exactly as before.
ARG APP_VERSION=
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION

RUN npm run build \
    && chown -R node:node /app

# Nothing after this point runs as root.
USER node

EXPOSE 3000

CMD ["npm", "start"]
