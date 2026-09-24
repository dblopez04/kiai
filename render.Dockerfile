# The render worker: danser + Xvfb + the kiai server code, run as `render-worker`. Built by
# compose.yaml (profiles "nvidia" and "cpu"). danser only ships x86_64 Linux builds.
FROM docker.io/library/node:22-bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive

# danser's runtime libraries (GL, X11, GTK3), Xvfb for its hidden window, and Mesa, which renders
# GL under Xvfb. Encoding goes through danser's bundled ffmpeg, which reaches NVENC by itself.
# dbus-x11 satisfies GTK's session-bus dependency without pulling in systemd.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip xvfb xauth dbus-x11 \
      libgl1 libglx-mesa0 libgl1-mesa-dri libx11-6 libgtk-3-0 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

ARG DANSER_VERSION=0.11.0
ARG DANSER_SHA256=c3184ceb84b20e8e9c9a2709113efc29b8bdf2f866949834d7fb8e799618a67e
RUN curl -fsSL -o /tmp/danser.zip "https://github.com/Wieku/danser-go/releases/download/${DANSER_VERSION}/danser-${DANSER_VERSION}-linux.zip" \
 && echo "${DANSER_SHA256}  /tmp/danser.zip" | sha256sum -c - \
 && mkdir -p /opt/danser \
 && unzip -q /tmp/danser.zip -d /opt/danser \
 && rm /tmp/danser.zip \
 && chmod 755 /opt/danser/danser /opt/danser/danser-cli /opt/danser/ffmpeg/ffmpeg /opt/danser/ffmpeg/ffprobe \
 # danser writes its settings, database and logs next to its binary.
 && chown -R node:node /opt/danser

WORKDIR /app
ENV NODE_ENV=production DANSER_DIR=/opt/danser

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @kiai/server && npm cache clean --force

COPY packages/server/src packages/server/src
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME /app/data
ENTRYPOINT ["node", "packages/server/src/main.ts"]
CMD ["render-worker"]
