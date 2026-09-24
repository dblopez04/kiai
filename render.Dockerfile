# The render worker: danser + Xvfb + the kiai server code, run as `render-worker`. Built by
# compose.yaml (profiles "nvidia" and "cpu"). danser only ships x86_64 Linux builds.
FROM docker.io/library/node:22-bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive

# danser's runtime libraries (GL, X11, GTK3), Xvfb for its hidden window, and Mesa, which renders
# GL under Xvfb when there's no GPU. Encoding goes through danser's bundled ffmpeg, which reaches
# NVENC by itself. dbus-x11 satisfies GTK's session-bus dependency without pulling in systemd.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip xvfb xauth dbus-x11 \
      libgl1 libglx-mesa0 libgl1-mesa-dri libx11-6 libgtk-3-0 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# VirtualGL (RENDER_GL=gpu): `vglrun -d egl` hands danser's OpenGL to the GPU through EGL while
# its window stays on Xvfb. Without it Mesa's llvmpipe draws every frame on the CPU, which is what
# made renders crawl. The NVIDIA EGL library comes from the host through nvidia-container-toolkit
# (the "graphics" capability); the vendor file below points glvnd at it when the toolkit doesn't
# add one itself, and is ignored when the library isn't there.
ARG TARGETARCH
ARG VIRTUALGL_VERSION=3.1.5
ARG VIRTUALGL_SHA256_amd64=df3f7788ce41b182a47c0d298e5cd6d2d63579522cb41825970b7726e825485e
ARG VIRTUALGL_SHA256_arm64=9ac238e8a18c06d84ef65444a591a7a5bb4c4ce9e8cfdd92f8a2aea35edbb5d7
RUN arch="${TARGETARCH:-amd64}" \
 && if [ "$arch" = arm64 ]; then sum="$VIRTUALGL_SHA256_arm64"; else sum="$VIRTUALGL_SHA256_amd64"; fi \
 && curl -fsSL -o /tmp/virtualgl.deb "https://github.com/VirtualGL/virtualgl/releases/download/${VIRTUALGL_VERSION}/virtualgl_${VIRTUALGL_VERSION}_${arch}.deb" \
 && echo "${sum}  /tmp/virtualgl.deb" | sha256sum -c - \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/virtualgl.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/virtualgl.deb \
 && mkdir -p /usr/share/glvnd/egl_vendor.d \
 && printf '{"file_format_version": "1.0.0", "ICD": {"library_path": "libEGL_nvidia.so.0"}}\n' > /usr/share/glvnd/egl_vendor.d/10_nvidia.json

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
