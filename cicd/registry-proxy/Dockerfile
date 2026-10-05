FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json .
COPY src/ src/
USER bun
EXPOSE 5050
CMD ["bun", "start"]
