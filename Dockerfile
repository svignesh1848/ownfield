FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY . .
RUN npm run build
FROM node:20-alpine
WORKDIR /app/server
ENV NODE_ENV=production WEB_DIR=/app/web/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./
COPY --from=build /app/web/dist /app/web/dist
EXPOSE 8080
CMD ["node","dist/index.js"]
