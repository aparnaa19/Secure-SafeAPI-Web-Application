const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Initialize Firebase Admin with service account
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const db = admin.firestore();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Serve your index.html at the root
app.use(express.static(path.join(__dirname)));

// ==============================================
// SECURITY LAYER: Rate Limiting (Cloud Armor equivalent)
// ==============================================

// Global rate limit - max 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  handler: async (req, res, next, options) => {
    console.log('Rate limit exceeded for IP:', req.ip);
    await logSecurityEvent({
      type: 'RATE_LIMIT_EXCEEDED',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      message: 'Global rate limit exceeded'
    });
    res.status(429).json(options.message);
  }
});

// Strict rate limit for login - max 5 attempts per minute per IP
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again in a minute.' },
  handler: async (req, res, next, options) => {
    console.log('Login rate limit exceeded for IP:', req.ip);
    await logSecurityEvent({
      type: 'LOGIN_RATE_LIMIT_EXCEEDED',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      message: 'Login rate limit exceeded - possible brute force attack'
    });
    res.status(429).json(options.message);
  }
});

// Apply global rate limit to all requests
app.use(globalLimiter);

// ==============================================
// SECURITY LAYER: Bot Detection
// ==============================================
function detectBot(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';

  // Block empty user agents
  if (!userAgent) {
    console.log('Blocked request with empty user agent from IP:', req.ip);
    logSecurityEvent({
      type: 'BOT_DETECTED_EMPTY_UA',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: 'empty',
      message: 'Blocked - empty user agent (bot pattern)'
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Block known bot patterns
  const botPatterns = ['curl', 'wget', 'python-requests', 'scrapy', 'bot', 'crawler', 'spider'];
  const isBot = botPatterns.some(pattern => userAgent.toLowerCase().includes(pattern));

  if (isBot) {
    console.log('Bot detected from IP:', req.ip, 'User-Agent:', userAgent);
    logSecurityEvent({
      type: 'BOT_DETECTED',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: userAgent,
      message: 'Blocked - known bot user agent pattern'
    });
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

// Apply bot detection to API routes
app.use('/api', detectBot);

// ==============================================
// SECURITY LAYER: App Check Verification
// ==============================================
async function verifyAppCheck(req, res, next) {
  const appCheckToken = req.headers['x-firebase-appcheck'];

  if (!appCheckToken) {
    console.log('No App Check token provided');
    await logSecurityEvent({
      type: 'APP_CHECK_MISSING',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      message: 'Request blocked - no App Check token'
    });
    return res.status(401).json({ error: 'Unauthorized - No App Check token' });
  }

  try {
    const appCheckClaims = await admin.appCheck().verifyToken(appCheckToken);
    console.log('App Check token verified for app:', appCheckClaims.appId);
    req.appId = appCheckClaims.appId;
    next();
  } catch (error) {
    console.log('App Check token invalid:', error.message);
    await logSecurityEvent({
      type: 'APP_CHECK_INVALID',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      message: 'Request blocked - invalid App Check token'
    });
    return res.status(401).json({ error: 'Unauthorized - Invalid App Check token' });
  }
}

// ==============================================
// Firestore: Log Security Events
// ==============================================
async function logSecurityEvent(eventData) {
  try {
    await db.collection('security_events').add({
      ...eventData,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('Security event logged to Firestore:', eventData.type);
  } catch (error) {
    console.error('Failed to log security event:', error.message);
  }
}

// ==============================================
// API ENDPOINTS
// ==============================================

// Login endpoint - protected by rate limit + bot detection + App Check
app.post('/api/login', loginLimiter, verifyAppCheck, async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'ID token is required' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email;

    console.log('User logged in successfully:', email);

    await logSecurityEvent({
      type: 'LOGIN_SUCCESS',
      status: 'ALLOWED',
      uid: uid,
      email: email,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      appId: req.appId,
      message: 'User logged in successfully'
    });

    res.json({
      success: true,
      message: 'Login successful',
      user: { uid, email }
    });

  } catch (error) {
    console.log('Token verification failed:', error.message);
    await logSecurityEvent({
      type: 'LOGIN_FAILED',
      status: 'BLOCKED',
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      message: 'Login failed - invalid token: ' + error.message
    });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Get security events
app.get('/api/security-events', async (req, res) => {
  try {
    const snapshot = await db.collection('security_events')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    const events = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate()
    }));

    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log client-side login failures
app.post('/api/login-failed', async (req, res) => {
  const { email, errorCode } = req.body;
  await logSecurityEvent({
    type: 'LOGIN_FAILED',
    status: 'BLOCKED',
    email: email || 'unknown',
    ip: req.ip,
    userAgent: req.headers['user-agent'] || 'unknown',
    message: 'Login failed - ' + (errorCode || 'invalid credentials')
  });
  res.json({ logged: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'SafeAPI server is running.' });
});

// ==============================================
// START SERVER
// ==============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  SafeAPI Server Started!
  ================================
  Local:   http://localhost:${PORT}
  Firebase Admin: Initialized
  App Check: Enabled
  Firestore: Connected
  Rate Limiting: Enabled (100 req/15min global, 5 req/min login)
  Bot Detection: Enabled
  CORS: Enabled
  ================================
  `);
});
