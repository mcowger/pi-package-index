FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM --platform=$TARGETPLATFORM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

# /repo is where the git clone lives (output/ and state/ are inside it)
VOLUME /repo

# State persists across runs inside the repo
ENV STATE_FILE=/repo/state/reviewed.json
ENV OUTPUT_DIR=/repo/output

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD []
