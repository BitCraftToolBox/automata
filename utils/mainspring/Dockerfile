FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY run.py ./
COPY mainspring/ ./mainspring/

VOLUME ["/app/config"]

ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD python -c "import os; exit(0 if os.path.exists('mainspring.log') else 1)"

CMD ["python", "run.py", "-c", "/app/config/config.yml"]
