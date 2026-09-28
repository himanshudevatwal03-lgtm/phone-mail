import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';
import * as db from './db.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (!production ? 'local-only-change-me' : '');
const otpProvider = process.env.OTP_PROVIDER || 'local';
const emailDomain = (process.env.EMAIL_DOMAIN || 'phonemail.com').toLowerCase();
const twilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
const twilioClient = twilioConfigured ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
const twilioToken = process.env.TWILIO_AUTH_TOKEN || '';
const attempts = new Map();

app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: false }));

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.until <= now) {
    attempts.set(key, { count: 1, until: now + windowMs });
    return { allowed: true, wait: 0 };
  }
  if (entry.count >= limit) return { allowed: false, wait: Math.ceil((entry.until - now) / 1000) };
  entry.count += 1;
  return { allowed: true, wait: 0 };
}

function hashOtp(phone, code) {
  return createHash('sha256').update(`${phone}:${code}:${jwtSecret}`).digest('hex');
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, phone: user.phone_e164 }, jwtSecret, { expiresIn: '30d' });
}

function safeUser(user) {
  return {
    id: user.id,
    phoneNumber: user.phone_e164,
    emailAddress: user.email_address,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    language: user.language,
    createdAt: user.created_at
  };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(token, jwtSecret);
    db.getUserById(payload.sub).then(user => {
      if (!user) return res.status(401).json({ error: 'This account is no longer available.' });
      req.user = user;
      next();
    }).catch(next);
  } catch {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
}

function verifyTwilioWebhook(req, res, next) {
  if (!production && !process.env.TWILIO_AUTH_TOKEN) return next();
  const signature = req.get('X-Twilio-Signature') || '';
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!base || !twilioToken || !twilio.validateRequest(twilioToken, signature, `${base}${req.originalUrl}`, req.body)) {
    return res.status(403).send('Invalid webhook signature.');
  }
  next();
}

function sendOtpLocal(phone, code) {
  return db.query(
    `INSERT INTO local_otps (phone_e164,code_hash,expires_at,attempts)
     VALUES ($1,$2,now()+interval '10 minutes',0)
     ON CONFLICT (phone_e164) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=now()`,
    [phone, hashOtp(phone, code)]
  );
}

async function sendSms(phone, body) {
  if (!twilioClient || !process.env.TWILIO_FROM_NUMBER) {
    if (!production) console.info(`[SMS dev] ${phone}: ${body}`);
    return { sent: false, reason: 'Twilio messaging is not configured.' };
  }
  const message = await twilioClient.messages.create({ to: phone, from: process.env.TWILIO_FROM_NUMBER, body });
  return { sent: true, sid: message.sid };
}

async function notifyRecipients(recipients, senderLabel, subject) {
  for (const recipient of recipients) {
    if (recipient.mobile_app_installed) continue;
    const body = `You have received an email from ${senderLabel}. Subject: ${subject || '(No subject)'}.`;
    sendSms(recipient.phone_e164, body).catch(error => console.warn('[SMS notification]', error.message));
  }
}

async function checkOtp(phone, code) {
  if (otpProvider === 'twilio') {
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!twilioClient || !serviceSid) throw Object.assign(new Error('Twilio Verify is not configured.'), { status: 503 });
    const result = await twilioClient.verify.v2.services(serviceSid).verificationChecks.create({ to: phone, code: String(code) });
    return result.status === 'approved';
  }
  const result = await db.query('SELECT code_hash,expires_at,attempts FROM local_otps WHERE phone_e164=$1', [phone]);
  const otp = result.rows[0];
  if (!otp || new Date(otp.expires_at).getTime() < Date.now() || otp.attempts >= 5) return false;
  const expected = Buffer.from(otp.code_hash, 'hex');
  const actual = Buffer.from(hashOtp(phone, String(code)), 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (match) await db.query('DELETE FROM local_otps WHERE phone_e164=$1', [phone]);
  else await db.query('UPDATE local_otps SET attempts=attempts+1 WHERE phone_e164=$1', [phone]);
  return match;
}

function twimlResponse(res, voice) {
  res.type('text/xml').send(voice.toString());
}

app.get('/api/config', (_req, res) => {
  res.json({ authMode: process.env.AUTH_MODE || 'otp', localOtp: otpProvider === 'local' && !production, emailDomain });
});

app.get('/api/health', async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ status: 'ok', database: 'postgres', authMode: process.env.AUTH_MODE || 'otp', otpProvider });
});

app.post('/api/auth/otp/request', async (req, res, next) => {
  try {
    const phone = db.normalizePhone(req.body.phone);
    const throttle = rateLimit(`otp:${phone}`, 5, 10 * 60_000);
    if (!throttle.allowed) return res.status(429).json({ error: `Too many codes requested. Try again in ${throttle.wait} seconds.` });
    if (req.body.intent === 'register' && await db.getUserByPhone(phone)) {
      return res.status(409).json({ error: 'That number already has a PhoneMail account. Sign in with the main client instead.' });
    }
    let developmentCode;
    if (otpProvider === 'twilio') {
      if (!twilioClient || !process.env.TWILIO_VERIFY_SERVICE_SID) return res.status(503).json({ error: 'Twilio Verify is not configured yet.' });
      await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID).verifications.create({ to: phone, channel: 'sms' });
    } else {
      if (production) return res.status(503).json({ error: 'Configure Twilio Verify for live OTP delivery, or set AUTH_MODE=password.' });
      developmentCode = String(randomInt(100000, 1_000_000));
      await sendOtpLocal(phone, developmentCode);
      console.info(`[OTP dev] ${phone} -> ${developmentCode}`);
    }
    res.json({ success: true, message: `Code sent to ${phone}.`, expiresInMinutes: 10, ...(developmentCode && !production ? { developmentCode } : {}) });
  } catch (error) { next(error); }
});

app.post('/api/auth/otp/verify', async (req, res, next) => {
  try {
    const phone = db.normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    const throttle = rateLimit(`verify:${phone}`, 10, 10 * 60_000);
    if (!throttle.allowed) return res.status(429).json({ error: `Too many attempts. Try again in ${throttle.wait} seconds.` });
    if (!await checkOtp(phone, code)) return res.status(400).json({ error: 'That code is incorrect or expired. Request a new one.' });
    if (req.body.intent === 'register' && await db.getUserByPhone(phone)) return res.status(409).json({ error: 'An account already exists for this number.' });
    const user = await db.getOrCreateUser(phone, { source: req.body.source || 'web', displayName: req.body.displayName || '' });
    res.json({ token: issueToken(user), user: safeUser(user), isNewUser: new Date(user.created_at).getTime() > Date.now() - 15_000 });
  } catch (error) { next(error); }
});

app.post('/api/auth/password/register', async (req, res, next) => {
  try {
    if ((process.env.AUTH_MODE || 'otp') !== 'password') return res.status(404).json({ error: 'Password fallback is disabled.' });
    const phone = db.normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
    if (await db.getUserByPhone(phone)) return res.status(409).json({ error: 'That number already has an account.' });
    const user = await db.setPasswordForPhone(phone, await bcrypt.hash(password, 12));
    res.status(201).json({ token: issueToken(user), user: safeUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/password/login', async (req, res, next) => {
  try {
    if ((process.env.AUTH_MODE || 'otp') !== 'password') return res.status(404).json({ error: 'Password fallback is disabled.' });
    const phone = db.normalizePhone(req.body.phone);
    const { rows } = await db.query('SELECT * FROM users WHERE phone_e164=$1', [phone]);
    const user = rows[0];
    if (!user?.password_hash || !await bcrypt.compare(String(req.body.password || ''), user.password_hash)) return res.status(401).json({ error: 'Phone number or password is incorrect.' });
    res.json({ token: issueToken(user), user: safeUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/password/continue', async (req, res, next) => {
  try {
    if ((process.env.AUTH_MODE || 'otp') !== 'password') return res.status(404).json({ error: 'Password fallback is disabled.' });
    const phone = db.normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
    const { rows } = await db.query('SELECT * FROM users WHERE phone_e164=$1', [phone]);
    let user = rows[0];
    if (!user) user = await db.setPasswordForPhone(phone, await bcrypt.hash(password, 12));
    else if (!user.password_hash || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Phone number or password is incorrect.' });
    res.json({ token: issueToken(user), user: safeUser(user) });
  } catch (error) { next(error); }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try { res.json({ ...safeUser(req.user), aliases: await db.getAliases(req.user.id) }); } catch (error) { next(error); }
});

app.get('/api/users/search', requireAuth, async (req, res, next) => {
  try { res.json(await db.searchUsers(req.user.id, req.query.q)); } catch (error) { next(error); }
});

app.post('/api/conversations/open', requireAuth, async (req, res, next) => {
  try {
    const conversation = await db.openConversation(req.user.id, req.body.phone);
    res.json({ id: conversation.id });
  } catch (error) { next(error); }
});

app.get('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const items = await db.listConversations(req.user.id, { folder: req.query.folder, filter: req.query.filter, search: req.query.search });
    res.json(items);
  } catch (error) { next(error); }
});

app.get('/api/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const conversation = await db.getConversation(req.user.id, req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(conversation);
  } catch (error) { next(error); }
});

app.post('/api/messages/compose', requireAuth, async (req, res, next) => {
  try {
    const to = Array.isArray(req.body.to) ? req.body.to : [];
    const result = await db.createMessage(req.user.id, { ...req.body, to });
    if (!req.body.isDraft) await notifyRecipients(result.recipients, req.user.display_name || req.user.email_address, result.message.subject);
    res.status(req.body.isDraft ? 200 : 201).json(result);
  } catch (error) { next(error); }
});

app.get('/api/drafts', requireAuth, async (req, res, next) => {
  try { res.json(await db.listDrafts(req.user.id)); } catch (error) { next(error); }
});

app.post('/api/drafts/:id/send', requireAuth, async (req, res, next) => {
  try {
    const result = await db.sendDraft(req.user.id, req.params.id, req.body);
    await notifyRecipients(result.recipients, req.user.display_name || req.user.email_address, result.message.subject);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

app.patch('/api/messages/:id/state', requireAuth, async (req, res, next) => {
  try { await db.changeMessageState(req.user.id, req.params.id, req.body); res.json({ success: true }); } catch (error) { next(error); }
});

app.get('/api/profile', requireAuth, async (req, res) => {
  res.json({ ...safeUser(req.user), aliases: await db.getAliases(req.user.id) });
});

app.put('/api/profile', requireAuth, async (req, res, next) => {
  try { res.json(safeUser(await db.updateProfile(req.user.id, req.body))); } catch (error) { next(error); }
});

app.post('/api/profile/mobile-app', requireAuth, async (req, res, next) => {
  try { await db.markMobileAppInstalled(req.user.id); res.json({ success: true }); } catch (error) { next(error); }
});

app.post('/api/aliases', requireAuth, async (req, res, next) => {
  try { res.status(201).json(await db.createAlias(req.user.id, req.body.alias)); } catch (error) { next(error); }
});

app.delete('/api/aliases/:id', requireAuth, async (req, res, next) => {
  try {
    if (!await db.deleteAlias(req.user.id, req.params.id)) return res.status(404).json({ error: 'Alias not found.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.post('/api/webhooks/email/inbound', async (req, res, next) => {
  try {
    if (!process.env.INBOUND_WEBHOOK_SECRET || req.get('X-PhoneMail-Webhook-Secret') !== process.env.INBOUND_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized webhook.' });
    const parsedTo = Array.isArray(req.body.to) ? req.body.to : String(req.body.to || '').split(',').map(value => value.trim()).filter(Boolean);
    const result = await db.ingestInboundEmail({
      fromEmail: req.body.fromEmail,
      fromName: req.body.fromName,
      toAddresses: parsedTo,
      subject: req.body.subject,
      bodyText: req.body.text,
      bodyHtml: req.body.html,
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : []
    });
    await notifyRecipients(result.recipients, req.body.fromName || req.body.fromEmail, req.body.subject);
    res.status(202).json({ accepted: true, conversationId: result.conversation.id, messageId: result.message.id });
  } catch (error) { next(error); }
});

app.post('/api/webhooks/twilio/voice', verifyTwilioWebhook, (req, res) => {
  const voice = new twilio.twiml.VoiceResponse();
  const gather = voice.gather({ numDigits: 1, action: '/api/webhooks/twilio/voice/complete', method: 'POST', timeout: 8 });
  gather.say('Welcome to PhoneMail. Press 1 to create an account using your phone number.');
  voice.say('We did not receive a selection. Please call again.');
  twimlResponse(res, voice);
});

app.post('/api/webhooks/twilio/voice/complete', verifyTwilioWebhook, async (req, res, next) => {
  try {
    const voice = new twilio.twiml.VoiceResponse();
    if (req.body.Digits !== '1') {
      voice.say('No account was created. Goodbye.');
      return twimlResponse(res, voice);
    }
    const user = await db.getOrCreateUser(req.body.From, { source: 'call' });
    voice.say(`Your PhoneMail account is ready. Your email address is ${user.email_address.split('@')[0].split('').join(' ')} at ${emailDomain}.`);
    sendSms(user.phone_e164, `Your PhoneMail account is ready. Email: ${user.email_address}`).catch(error => console.warn('[IVR SMS]', error.message));
    twimlResponse(res, voice);
  } catch (error) { next(error); }
});

app.post('/api/webhooks/twilio/sms', verifyTwilioWebhook, async (req, res, next) => {
  try {
    const voice = new twilio.twiml.MessagingResponse();
    const keyword = String(req.body.Body || '').trim().toLowerCase();
    if (!['1', 'start', 'join', 'phonemail'].includes(keyword)) {
      voice.message('Reply START to create a PhoneMail account.');
      return res.type('text/xml').send(voice.toString());
    }
    const user = await db.getOrCreateUser(req.body.From, { source: 'sms' });
    voice.message(`Your PhoneMail account is ready. Email: ${user.email_address}`);
    res.type('text/xml').send(voice.toString());
  } catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

if (production) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.resolve(here, '../dist')));
  app.get(/.*/, (_req, res) => res.sendFile(path.resolve(here, '../dist/index.html')));
}

app.use((error, _req, res, _next) => {
  const status = error.status || (error.code === '23505' ? 409 : 400);
  if (status >= 500) console.error('[API]', error);
  res.status(status).json({ error: error.message || 'Request failed.' });
});

if (production && (!jwtSecret || jwtSecret === 'replace-this-before-deploying')) {
  throw new Error('Set JWT_SECRET to a unique random value before production use.');
}

await db.initializeDatabase();
app.listen(port, '0.0.0.0', () => console.info(`[PhoneMail] listening on ${port} (${process.env.NODE_ENV || 'development'})`));
