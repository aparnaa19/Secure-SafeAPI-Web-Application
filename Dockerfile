# Use lightweight Node.js base image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (for efficient caching)
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the rest of the application files
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
