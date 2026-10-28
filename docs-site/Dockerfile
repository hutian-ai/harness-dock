FROM node:22-alpine AS build
WORKDIR /app
COPY package.json build.mjs ./
COPY src ./src
COPY public ./public
RUN node build.mjs
FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
