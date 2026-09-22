FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json README.md .env.example ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs
COPY tests ./tests
RUN node scripts/doctor.js
EXPOSE 8312 8412
CMD ["node", "server/index.js"]
