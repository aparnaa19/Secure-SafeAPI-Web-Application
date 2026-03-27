# SafeAPI Security Layers

This document explains every security layer in detail - what it is, why we need it, how it works, and what attack it prevents.

---

## The Threat Landscape

Before building security, we need to understand what we're protecting against:

| Attack Type | What Happens | Impact |
|-------------|-------------|--------|
| **Credential Stuffing** | Attacker tries millions of username/password combinations | Account takeover |
| **Brute Force** | Attacker repeatedly tries passwords for one account | Account takeover |
| **Bot Abuse** | Automated scripts call your API thousands of times | Server overload, cost |
| **DDoS** | Flood of requests overwhelms your server | Service downtime |
| **SQL Injection** | Malicious code injected into inputs | Data theft/corruption |
| **API Scraping** | Bots harvest your data | Data theft |
| **Token Replay** | Stolen tokens reused to access APIs | Unauthorized access |

---

## Security Layer 1: Firebase Authentication

### What is it?
Firebase Authentication is Google's managed identity service. It handles user registration, login, and session management.

### How it works
1. User enters email and password
2. Firebase verifies credentials against its secure database
3. If valid, Firebase generates a **JWT (JSON Web Token) ID Token**
4. This token is signed with Firebase's private key
5. Our backend verifies this token using Firebase Admin SDK

### What is a JWT Token?
A JWT (JSON Web Token) is a compact, self-contained token with three parts:
```
header.payload.signature
```
- **Header**: Algorithm used to sign
- **Payload**: User data (email, UID, expiry time)
- **Signature**: Cryptographic proof it hasn't been tampered with

You can inspect a JWT at [jwt.io](https://jwt.io) — paste the token and see what's inside.

### What attacks does this prevent?
- Unauthorized access — only users with valid credentials can log in
- Token tampering — signature verification catches modified tokens
- Token expiry — tokens automatically expire and must be refreshed

### Testing in Postman
To test Firebase Auth directly in Postman:
- Method: POST
- URL: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=YOUR_API_KEY`
- Body:
```json
{
  "email": "user@example.com",
  "password": "yourpassword",
  "returnSecureToken": true
}
```
- Response contains the `idToken` (JWT)

---

## Security Layer 2: Firebase App Check + reCAPTCHA Enterprise

### What is App Check?
App Check answers one critical question: **"Is this request coming from my real app or from a script?"**

Without App Check, anyone who finds your Firebase API key can call your backend directly from scripts, Postman, or terminal. App Check prevents this.

### The Two-Step Identity Model
SafeAPI uses a two-step verification:
1. **App Check** — verifies the APPLICATION is legitimate
2. **Firebase Auth** — verifies the USER is legitimate

Both must pass for a login to succeed.

### How reCAPTCHA Enterprise works
reCAPTCHA Enterprise is Google's advanced bot detection service. Unlike the old reCAPTCHA (with "I'm not a robot" checkboxes), Enterprise works **invisibly** in the background.

It analyzes:
- Browser fingerprint
- Mouse movement patterns
- Keystroke timing
- Network characteristics
- Browser environment integrity

It assigns a **risk score from 0.0 to 1.0**:
- **1.0** = Almost certainly a human
- **0.5** = Uncertain
- **0.0** = Almost certainly a bot

### The App Check Flow
```
Browser                    Firebase                   Our Server
   │                          │                           │
   │── Load page ─────────────│                           │
   │                          │                           │
   │── reCAPTCHA runs ────────│                           │
   │   (silent, background)   │                           │
   │                          │                           │
   │── Request App Check ─────▶                           │
   │   token                  │                           │
   │                          │── Verify reCAPTCHA ──────│
   │                          │   attestation             │
   │                          │                           │
   │◀─ App Check JWT token ───│                           │
   │                          │                           │
   │── POST /api/login ───────────────────────────────────▶
   │   X-Firebase-AppCheck: [token]                       │
   │   Body: { idToken: "..." }                           │
   │                          │                           │
   │                          │◀── Verify App Check ──────│
   │                          │    token                  │
   │                          │                           │
   │                          │─── Valid ─────────────────▶
   │                          │                           │── Verify ID token
   │                          │                           │
   │◀──────────────────────────────────── Login Success ──│
```

### The X-Firebase-AppCheck Header
When calling our backend, the App Check token is sent in a special header:
```
X-Firebase-AppCheck: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```
If this header is missing or invalid, our server returns:
```json
{ "error": "Unauthorized - No App Check token" }
```

### Token Time to Live
App Check tokens are valid for **1 hour** by default. The Firebase SDK automatically refreshes them before they expire, so users don't need to do anything.

### App Check Enforcement
In Firebase Console → App Check → APIs, we set Authentication to **Enforced**. This means:
- All requests to Firebase services must include a valid App Check token
- Requests without a valid token are automatically rejected
- Firebase Console shows metrics: verified vs unverified requests

### What attacks does this prevent?
- Direct API calls from scripts/terminal
- Automated bots calling your endpoints
- API key abuse (even if someone steals your Firebase API key, they can't use it without a valid App Check token)
- Unauthorized app instances

---

## Security Layer 3: Rate Limiting & Bot Detection

### What is Rate Limiting?
Rate limiting restricts how many requests a client can make in a time window. It's like a speed limit for your API.

### Our Rate Limits
```
Global limit:  100 requests per 15 minutes per IP
Login limit:    5 requests per 1 minute per IP
```

**Why these numbers?**
- A real human can't login more than 5 times per minute
- If someone is trying 6+ logins per minute, it's a bot or brute force attack
- The global limit prevents any kind of API abuse

### What happens when limit is exceeded?
```json
HTTP 429 Too Many Requests
{
  "error": "Too many login attempts, please try again in a minute."
}
```
The event is also logged to Firestore as `LOGIN_RATE_LIMIT_EXCEEDED`.

### Bot Detection via User-Agent
Every HTTP request includes a **User-Agent header** that identifies the client:
- Real browser: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...`
- curl: `curl/7.68.0`
- Python: `python-requests/2.28.0`

Our server checks for known bot patterns:
```javascript
const botPatterns = ['curl', 'wget', 'python-requests', 'scrapy', 'bot', 'crawler', 'spider'];
```

If a bot pattern is detected → **403 Forbidden**

### Empty User-Agent Blocking
Malicious scripts often send requests with no User-Agent header at all. Our server blocks these immediately:
- Empty user agent = suspicious = blocked
- Logged as `BOT_DETECTED_EMPTY_UA`

### What attacks does this prevent?
- Brute force attacks (rate limiting stops password guessing)
- Credential stuffing (rate limiting stops bulk login attempts)
- Bot scraping (user-agent detection blocks common tools)
- API flooding (global rate limit prevents overwhelming the server)

---

## Security Layer 4: Cloud Armor

### What is Cloud Armor?
Cloud Armor is Google's **Web Application Firewall (WAF)** and DDoS protection service. It operates at the **network level**, before requests even reach your application.

### How it differs from application-level security
| | Application-Level (our code) | Cloud Armor |
|--|------------------------------|-------------|
| Where | Inside Node.js server | At Load Balancer |
| When | After request reaches server | Before request reaches server |
| Performance | Server processes bad requests | Bad requests never reach server |
| Scale | Limited by server capacity | Google's global infrastructure |

### Cloud Armor Rules We Defined

**Rate-based rule:**
- Maximum 100 requests per minute per IP
- Exceed action: Deny 429
- Applies to all traffic globally

**Pre-configured WAF rules (what would be added):**
- SQL injection detection
- Cross-site scripting (XSS) detection
- HTTP flood attack detection

**Custom rules possible:**
- Block specific IP ranges
- Block traffic from specific countries
- Block specific user-agent strings
- Block requests with suspicious headers

### The OTP Endpoint Example
Your professor gave a great real-world example: **securing a Send OTP endpoint**.

Without Cloud Armor:
- Bot calls `/send-otp` 1000 times per second for the same phone number
- SMS costs you $0.01 each = $10 in seconds
- Phone number owner gets 1000 texts

With Cloud Armor:
- Rule: Allow only 1 request per minute per IP for `/send-otp`
- Bot gets blocked after first request
- Cost = $0.01, phone owner gets 1 text

### Cloud Armor + reCAPTCHA Session Tokens (Advanced)
An advanced feature discussed in class:
- reCAPTCHA sets a **session cookie** in the user's browser
- Cloud Armor can read this cookie and check the score
- Rules can block requests with score below 0.8
- This is "Level 4" security — network-level bot filtering using reCAPTCHA scores

### Why Cloud Armor was limited in our project
Cloud Armor requires a **global security policy quota** which is set to 0 for new Google Cloud accounts. This is a Google billing/account maturity restriction. The quota must be requested and approved by Google support.

---

## Firestore Security Event Logging

### Why log security events?
Logging serves multiple purposes:
- **Auditing**: Know exactly what happened and when
- **Incident response**: Understand an attack after it happens
- **Pattern detection**: Identify recurring attack sources
- **Compliance**: Many regulations require security logging
- **Debugging**: Understand why legitimate users are being blocked

### What we log
Every event stored in Firestore's `security_events` collection:

```json
{
  "type": "LOGIN_SUCCESS",
  "status": "ALLOWED",
  "email": "user@example.com",
  "uid": "firebase-uid-123",
  "ip": "::1",
  "userAgent": "Mozilla/5.0...",
  "appId": "1:452254762534:web:743a...",
  "message": "User logged in successfully",
  "timestamp": "2026-03-17T14:23:45Z"
}
```

### Event Types

| Type | Status | Meaning |
|------|--------|---------|
| `LOGIN_SUCCESS` | ALLOWED | Valid login |
| `LOGIN_FAILED` | BLOCKED | Wrong credentials |
| `APP_CHECK_MISSING` | BLOCKED | No App Check token in header |
| `APP_CHECK_INVALID` | BLOCKED | Token present but invalid/expired |
| `RATE_LIMIT_EXCEEDED` | BLOCKED | Too many global requests |
| `LOGIN_RATE_LIMIT_EXCEEDED` | BLOCKED | Too many login attempts |
| `BOT_DETECTED` | BLOCKED | Known bot user agent |
| `BOT_DETECTED_EMPTY_UA` | BLOCKED | Empty user agent header |

### Real-world use case
In a real Security Operations Center (SOC), analysts would:
1. Monitor these logs in real-time
2. Set up alerts for unusual patterns
3. Block persistent attacker IPs
4. Generate reports on attack volumes
5. Use this data to tune security rules
