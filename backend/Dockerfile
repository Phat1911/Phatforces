FROM golang:1.22-alpine AS builder

WORKDIR /src
RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/server ./cmd/main.go

FROM alpine:3.20

WORKDIR /app
RUN apk add --no-cache ffmpeg ca-certificates tzdata

COPY --from=builder /out/server /app/server

ENV PORT=8080
ENV UPLOAD_DIR=/app/uploads

EXPOSE 8080

CMD ["/app/server"]
