FROM python:3.12-slim
# تصویر xray کنارش نیست؛ باینری xray را نصب می‌کنیم
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && curl -L -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
    && unzip /tmp/xray.zip xray -d /usr/local/bin && chmod +x /usr/local/bin/xray \
    && rm -rf /var/lib/apt/lists /tmp/xray.zip
COPY stats.py /app/stats.py
WORKDIR /app
EXPOSE 9000
CMD ["python", "stats.py"]
