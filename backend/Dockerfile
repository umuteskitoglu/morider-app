# ---- build stage ----
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# -s -w strips the symbol table and DWARF debug info; -trimpath drops absolute
# build paths. Smaller binary, smaller image, slightly smaller memory footprint.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /app/service ./cmd/morider

# ---- runtime stage ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=build /app/service /app/service

# The concrete service is selected via the -service flag in docker-compose.
ENTRYPOINT ["/app/service"]
