FROM python:3.11-slim

WORKDIR /app
COPY requirements-web.txt .
RUN pip install --no-cache-dir -r requirements-web.txt

COPY app.py db.py ./
COPY public ./public

ENV PORT=3000
ENV RESTROKOT_DATA_DIR=/app/data

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["gunicorn", "--bind", "0.0.0.0:3000", "--workers", "1", "--threads", "16", "--worker-class", "gthread", "--timeout", "0", "app:app"]
