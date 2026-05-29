# ---- build stage ----
FROM golang:1.25-alpine AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/service ./cmd/morider

# ---- runtime stage ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=build /app/service /app/service

# The concrete service is selected via the -service flag in docker-compose.
ENTRYPOINT ["/app/service"]
