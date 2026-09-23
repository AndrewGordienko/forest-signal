FROM node:22-alpine AS ui
WORKDIR /project
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.12-slim
WORKDIR /project
COPY pyproject.toml ./
COPY backend ./backend
RUN pip install --no-cache-dir .
COPY data ./data
COPY --from=ui /project/dist ./dist
EXPOSE 8014
CMD ["uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "8014"]
