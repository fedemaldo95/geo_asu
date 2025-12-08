FROM node:18-alpine

WORKDIR /app

# Copiar package.json y instalar dependencias
COPY package.json ./
RUN npm install --production

# Copiar el resto del código
COPY . .

# Exponer puerto
EXPOSE 3000

# Comando para iniciar
CMD ["node", "server.js"]
