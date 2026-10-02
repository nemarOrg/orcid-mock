# orcid-mock as a container: one static-ish binary on a distroless base, no shell, no curl.
#
#   docker build -t orcid-mock .
#   docker run --rm -p 127.0.0.1:9700:9700 -e PUBLIC_BASE_URL=http://localhost:9700 orcid-mock
#
# Both base images are pinned by digest (the multi-arch index, so amd64 and arm64 builds share
# the pin); bump the digest and the tag together, and let the CI docker job prove the result.

ARG BUN_IMAGE=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

# The builder runs on the machine doing the build and cross-compiles for TARGETARCH, so a
# multi-arch build never runs Bun under emulation; only the final stage is per-architecture.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY scripts/build-binaries.ts scripts/
COPY src src
RUN case "${TARGETARCH}" in \
      amd64) target=linux-x64 ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && bun scripts/build-binaries.ts --target "${target}" --out /out \
    && mv "/out/orcid-mock-${target}" /out/orcid-mock

FROM ${RUNTIME_IMAGE}
ARG VERSION=dev
# The commit the image was built from; the release workflow compares it with the commit it is
# running for before it will touch an existing tag.
ARG REVISION=unknown
LABEL org.opencontainers.image.title="orcid-mock" \
      org.opencontainers.image.description="An ephemeral mock of the ORCID OAuth, OpenID Connect, and public record API for tests and CI" \
      org.opencontainers.image.source="https://github.com/nemarOrg/orcid-mock" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build /out/orcid-mock /orcid-mock
# The admin API is unauthenticated, so the binary binds loopback by default; inside a container
# the container network is the boundary, so bind every interface. Set PUBLIC_BASE_URL too: the
# default, http://127.0.0.1:9700, means nothing to a caller outside the container.
ENV HOST=0.0.0.0 PORT=9700
EXPOSE 9700
USER nonroot
ENTRYPOINT ["/orcid-mock"]
# The image has no shell and no curl, so the binary checks itself: `health` without --url looks at
# http://127.0.0.1:$PORT, so the check follows a PORT override. Failures during the start period
# do not count, and the check runs every second until the first success.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --start-interval=1s --retries=5 \
  CMD ["/orcid-mock", "health"]
