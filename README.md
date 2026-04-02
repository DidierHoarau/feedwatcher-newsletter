# FeedWatcher Newsletter

FeedWatcher Newsletter is a server-only service that connects to an IMAP mailbox, retrieves newsletter emails, and exposes each sender's emails as an individual RSS feed. It is designed to bridge email newsletters into any RSS reader, including [FeedWatcher](https://github.com/didierhoarau/feedwatcher).

# Philosophy

This project is a server-only companion to FeedWatcher. It has no UI and requires no external database. Emails are stored on disk as a JSON file and automatically purged after a configurable retention period. The goal is a lightweight, self-contained service that converts an email inbox into subscribable RSS feeds.

One RSS feed is generated per unique sender name. Each feed's items are the email bodies (HTML preferred, plain text fallback) from that sender, ordered by date received.

# Deployment

FeedWatcher Newsletter is designed to be deployed as a container.

- This image exposes port `8080`
- The data volume is located at `/data`

## Docker

```bash
mkdir -p data
docker run --name feedwatcher-newsletter \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e IMAP_HOST=imap.example.com \
  -e IMAP_USER=newsletter@example.com \
  -e IMAP_PASSWORD=yourpassword \
  -e IMAP_MAILBOX=INBOX \
  -d feedwatcher-newsletter
```

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: feedwatcher-newsletter
  labels:
    app: feedwatcher-newsletter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: feedwatcher-newsletter
  template:
    metadata:
      labels:
        app: feedwatcher-newsletter
    spec:
      containers:
        - image: feedwatcher-newsletter
          name: feedwatcher-newsletter
          env:
            - name: IMAP_HOST
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_HOST
            - name: IMAP_USER
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_USER
            - name: IMAP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_PASSWORD
          resources:
            limits:
              memory: 256Mi
              cpu: 500m
            requests:
              memory: 128Mi
              cpu: 50m
          readinessProbe:
            httpGet:
              path: /api/status
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: feedwatcher-newsletter
spec:
  ports:
    - name: tcp
      port: 8080
      targetPort: 8080
  selector:
    app: feedwatcher-newsletter
```

# Configuration

Configuration values can be set via environment variables or through the `config.json` file. Environment variables take precedence over config file values, which take precedence over defaults.

## IMAP

| Variable        | Description                        | Default |
| --------------- | ---------------------------------- | ------- |
| `IMAP_HOST`     | IMAP server hostname               |         |
| `IMAP_PORT`     | IMAP server port                   | `993`   |
| `IMAP_TLS`      | Enable TLS for the IMAP connection | `true`  |
| `IMAP_USER`     | IMAP account username              |         |
| `IMAP_PASSWORD` | IMAP account password              |         |
| `IMAP_MAILBOX`  | Mailbox folder to read emails from | `INBOX` |

## General

| Variable               | Description                                        | Default                 |
| ---------------------- | -------------------------------------------------- | ----------------------- |
| `PUBLIC_URL`           | Public base URL of the service (used in feed URLs) | `http://localhost:8080` |
| `EMAIL_FETCH_CRON`     | Cron expression for the email fetch schedule       | `0 * * * *` (hourly)    |
| `EMAIL_RETENTION_DAYS` | Number of days to retain emails before purging     | `7`                     |
| `DATA_DIR`             | Directory for persisting email data                | `/data`                 |

## OpenTelemetry

| Variable                                                  | Description                                 | Default |
| --------------------------------------------------------- | ------------------------------------------- | ------- |
| `OPENTELEMETRY_COLLECTOR_HTTP_TRACES`                     | OTel collector URL for traces               |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS`                    | OTel collector URL for metrics              |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_LOGS`                       | OTel collector URL for logs                 |         |
| `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS`    | Log export interval in seconds              | `60`    |
| `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` | Metrics export interval in seconds          | `60`    |
| `OPENTELEMETRY_COLLECTOR_AWS`                             | Enable AWS OTel collector                   | `false` |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`              | Authorization header for the OTel collector |         |

# API

| Method | Path       | Description                                         |
| ------ | ---------- | --------------------------------------------------- |
| `GET`  | `/rss/`    | List all available RSS feeds (one per sender)       |
| `GET`  | `/rss/:id` | Get the RSS feed for a specific sender by sender ID |

The sender ID is derived from the sender name by lowercasing it and removing all non-alphanumeric characters (e.g., `"The Daily Newsletter"` → `thedailynewsletter`).

The `/rss/` list response returns a JSON array with the following fields per sender:

```json
[
  {
    "id": "thedailynewsletter",
    "senderName": "The Daily Newsletter",
    "senderEmail": "news@example.com",
    "feedUrl": "http://localhost:8080/rss/thedailynewsletter"
  }
]
```
