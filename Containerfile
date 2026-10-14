FROM docker.io/library/node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tigervnc-standalone-server xdotool chromium dbus procps curl fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/chromium /usr/local/bin/google-chrome-stable \
    && ln -s /usr/bin/chromium /usr/local/bin/google-chrome
COPY package.json /opt/screens/package.json
COPY dist /opt/screens/dist
USER node
ENTRYPOINT ["node", "/opt/screens/dist/screens-init.js", "--oci"]
