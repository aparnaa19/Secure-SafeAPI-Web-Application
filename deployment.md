# SafeAPI Deployment Guide

This document explains every step of deploying SafeAPI to Google Cloud, why each step is needed, and what happens behind the scenes.

---

## Prerequisites

Before deploying, make sure you have:
- Google Cloud account with billing enabled
- Firebase project created
- Google Cloud SDK (`gcloud`) installed
- Node.js 18+ installed
- Docker Desktop installed (optional - gcloud handles it automatically)

---

## Step 1: Firebase Setup

### 1.1 Create Firebase Project
1. Go to [firebase.google.com](https://firebase.google.com)
2. Click "Get Started" → "Create a project"
3. Name it `safeapi`
4. Enable Google Analytics (optional)

### 1.2 Enable Email/Password Authentication
1. Firebase Console → Build → Authentication
2. Sign-in method tab → Email/Password → Enable

### 1.3 Add a Web App
1. Project Settings → Your apps → Add app → Web (`</>`)
2. Register app name as `safeapi-web`
3. Copy the `firebaseConfig` object - you'll need this in `index.html`

### 1.4 Create a Test User
1. Authentication → Users → Add user
2. Enter email and password
3. This is what you'll use to test login

---

## Step 2: reCAPTCHA Enterprise Setup

### 2.1 Enable the API
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Make sure you're in your **safeapi** project
3. Search "reCAPTCHA Enterprise" → Enable API

### 2.2 Create a Site Key
1. Security → reCAPTCHA → Create Key
2. Display name: `safeapi-key`
3. Platform type: Web
4. Domain: Add `localhost` (for development)
5. After deployment, also add your Cloud Run domain
6. Click Create → Copy the **Site Key**

---

## Step 3: Firebase App Check Setup

### 3.1 Register App with App Check
1. Firebase Console → App Check → Apps tab
2. Click on `safeapi-web`
3. Select **reCAPTCHA Enterprise**
4. Paste your Site Key
5. Token time to live: 1 hour (default)
6. Click Save

### 3.2 Enforce App Check
1. App Check → APIs tab
2. Click on Authentication
3. Click **Enforce**
4. Confirm — this now rejects requests without valid App Check tokens

---

## Step 4: Service Account Key

The backend server needs to communicate with Firebase securely. This is done via a **Service Account Key**.

### What is a Service Account?
A service account is a special Google account for applications (not humans). It has specific permissions and uses a key file instead of a password.

### Generate the Key
1. Firebase Console → Project Settings (gear icon)
2. Service accounts tab
3. Click "Generate new private key"
4. Download the JSON file
5. Rename it to `serviceAccountKey.json`
6. Place it in your project root folder

## Step 5: Local Development

### 5.1 Install Dependencies
```bash
npm install
```

This installs:
- `express` — web framework
- `firebase-admin` - Firebase server SDK
- `cors` — Cross-Origin Resource Sharing
- `express-rate-limit` - rate limiting middleware

### 5.2 Run Locally
```bash
node server.js
```

Server starts at `http://localhost:3000`

### 5.3 Serve the Frontend
The server automatically serves `index.html` via:
```javascript
app.use(express.static(path.join(__dirname)));
```

---

## Step 6: Docker Containerization

### What is Docker?
Docker packages your application and all its dependencies into a **container** - a lightweight, portable unit that runs identically everywhere.

**The problem Docker solves:** "It works on my machine but not in production"

### Our Dockerfile Explained
```dockerfile
# Use lightweight Node.js base image (Alpine Linux)
FROM node:18-alpine
# Alpine is a minimal Linux distribution - image is ~50MB vs ~900MB for full Ubuntu

# Set working directory inside container
WORKDIR /app
# All subsequent commands run from /app

# Copy package files first (Docker caching optimization)
COPY package*.json ./
# By copying package.json first, Docker can cache the npm install layer
# If only your code changes (not dependencies), Docker reuses the cached layer

# Install only production dependencies
RUN npm install --production
# --production skips devDependencies, keeping image smaller

# Copy all application files
COPY . .
# Copies index.html, server.js, etc.

# Expose port 3000
EXPOSE 3000
# Documents which port the app uses (Cloud Run overrides with PORT env var)

# Start command
CMD ["node", "server.js"]
# This runs when the container starts
```

### Why node:18-alpine?
- **Alpine Linux** is a minimal Linux distribution (~5MB)
- Results in smaller Docker images (~150MB vs ~900MB)
- Smaller images = faster deployments, less storage cost
- Production-grade - widely used in industry

---

## Step 7: Deploying to Google Cloud Run

### What is Cloud Run?
Cloud Run is Google's **serverless container platform**. You give it a Docker image and it:
- Runs it automatically
- Scales from 0 to 1000+ instances based on traffic
- Charges only for actual usage (per request)
- Provides a managed HTTPS URL

### The Deploy Command
```bash
gcloud run deploy safeapi \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

**What each flag means:**
- `safeapi` - name of the Cloud Run service
- `--source .` - use current directory (gcloud builds Docker image automatically)
- `--platform managed` - use fully managed Cloud Run (not Kubernetes)
- `--region us-central1` - deploy to Iowa, USA data center
- `--allow-unauthenticated` - allow public access (no Google auth required)

### What happens behind the scenes
1. gcloud zips your source code
2. Uploads to Google Cloud Build
3. Cloud Build reads your Dockerfile and builds the image
4. Built image is stored in **Artifact Registry**
5. Cloud Run pulls the image and deploys it
6. A revision is created and traffic is routed to it
7. You get a URL: `https://safeapi-452254762534.us-central1.run.app`

### The PORT Environment Variable
Cloud Run sets `PORT=8080` automatically. Our server handles this:
```javascript
const PORT = process.env.PORT || 3000;
```
- In production (Cloud Run): uses 8080
- In local development: uses 3000

---

## Step 8: Load Balancer Setup

### Why do we need a Load Balancer?
Cloud Run already provides a URL. We add a Load Balancer because:
1. **Custom domain support** - use your own domain name
2. **SSL certificate management** - automatic HTTPS
3. **Cloud Armor** - can only be attached to Load Balancers
4. **Traffic routing** - route different paths to different services

### Load Balancer Components

```
Forwarding Rule → Target HTTP Proxy → URL Map → Backend Service → Serverless NEG → Cloud Run
```

| Component | Purpose |
|-----------|---------|
| **Forwarding Rule** | Accepts traffic on port 80/443, has a public IP |
| **Target HTTP Proxy** | Handles HTTP protocol, reads URL maps |
| **URL Map** | Routes traffic based on URL paths |
| **Backend Service** | Defines the backend, where Cloud Armor attaches |
| **Serverless NEG** | Connects Load Balancer to Cloud Run |

### Creating via CLI
```bash
# 1. Create backend service
gcloud compute backend-services create safeapi-backend --global

# 2. Create URL map
gcloud compute url-maps create safeapi-urlmap --default-service safeapi-backend

# 3. Create HTTP proxy
gcloud compute target-http-proxies create safeapi-proxy --url-map safeapi-urlmap

# 4. Create forwarding rule (this creates the public IP)
gcloud compute forwarding-rules create safeapi-forwarding-rule \
  --global --target-http-proxy safeapi-proxy --ports 80

# 5. Create Serverless NEG
gcloud compute network-endpoint-groups create safeapi-neg \
  --region=us-central1 \
  --network-endpoint-type=serverless \
  --cloud-run-service=safeapi
```

---

## Step 9: Cloud Armor

### Attach to Load Balancer
1. Google Cloud Console → Network Security → Cloud Armor
2. Create Policy:
   - Name: `safeapi-policy`
   - Type: Backend security policy
   - Scope: Global
3. Add Rules:
   - Rate limiting: 100 req/min, Deny 429
4. Apply to target: `safeapi-backend`

### Cloud Armor is now the first line of defense
```
Internet → Cloud Armor (blocks bad traffic) → Load Balancer → Cloud Run → Your App
```

---

## Step 10: Secret Manager 

### Why Secret Manager?
Currently, `serviceAccountKey.json` is a file in our project. This is fine for development but **not recommended for production** because:
- File could accidentally be committed to GitHub
- Anyone with server access can read it
- Hard to rotate credentials

### The Better Way: Secret Manager
1. Store the service account key in Google Secret Manager
2. Reference it as an environment variable in Cloud Run
3. Code reads from environment variable, never touches a file

### How to set it up
```bash
# Create a secret
gcloud secrets create firebase-service-account --data-file=serviceAccountKey.json

# Reference in Cloud Run
gcloud run services update safeapi \
  --set-secrets=FIREBASE_SERVICE_ACCOUNT=firebase-service-account:latest
```

In `server.js`:
```javascript
// Instead of reading from file:
const serviceAccount = require('./serviceAccountKey.json');

// Read from environment variable:
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
```

**Benefits:**
- Secret never touches the filesystem
- Access controlled via IAM permissions
- Automatic audit trail of who accessed what
- Easy credential rotation without redeployment

---

