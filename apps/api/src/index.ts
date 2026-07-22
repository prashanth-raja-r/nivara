import dotenv from 'dotenv';
import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { OAuth2Client } from 'google-auth-library';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import multer from 'multer';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaClient, LoanKind } from '@nivara/database';
import { z } from 'zod';

dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), '../../.env') });

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && (!process.env.DATABASE_URL || !process.env.JWT_SECRET)) {
  throw new Error('DATABASE_URL and JWT_SECRET must be configured in production.');
}

const db = new PrismaClient();
const app = express();
const google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const secret = process.env.JWT_SECRET || 'development-only-change-me';
const configuredOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins);
if (!isProduction) allowedOrigins.add('http://localhost:5173');

const localVaultPath = resolve(process.env.DOCUMENTS_LOCAL_PATH || join(process.cwd(), 'storage', 'vault'));
mkdirSync(localVaultPath, { recursive: true });
const s3Bucket = process.env.S3_BUCKET;
const cloudStorageEnabled = Boolean(s3Bucket && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
const s3 = cloudStorageEnabled ? new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
}) : null;
if (isProduction && !cloudStorageEnabled) console.warn('Cloud document storage is not configured. Document uploads are disabled in production.');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype)),
});

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string; name: string };
    }
  }
}

const tokenFor = (user: { id: string; email: string; name: string }) => jwt.sign({ sub: user.id, email: user.email, name: user.name }, secret, { expiresIn: '7d' });
const publicUser = (user: { id: string; name: string; email: string; avatarUrl: string | null }) => ({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
const authSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const loanSchema = z.object({ name: z.string().min(2), kind: z.nativeEnum(LoanKind), principal: z.number().positive(), outstanding: z.number().nonnegative(), interestRate: z.number().nonnegative(), termMonths: z.number().int().positive(), emi: z.number().nonnegative().default(0), startDate: z.coerce.date(), paymentDueDay: z.number().int().min(1).max(28).default(5) });
const profileSchema = z.object({ monthlyIncome: z.number().nonnegative(), essentialExpenses: z.number().nonnegative(), monthlySavings: z.number().nonnegative(), emergencyFund: z.number().nonnegative(), incomeFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY']).default('MONTHLY'), bonusAmount: z.number().nonnegative().default(0), bonusFrequency: z.enum(['NONE', 'ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY']).default('NONE') });

function requireAuth(request: Request, response: Response, next: NextFunction) {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return response.status(401).json({ message: 'Sign in is required.' });
  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Invalid token.');
    request.auth = { userId: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : payload.email };
    return next();
  } catch {
    return response.status(401).json({ message: 'Your session has expired. Please sign in again.' });
  }
}

function requireCurrentUser(request: Request, response: Response, next: NextFunction) {
  if (request.params.userId !== request.auth?.userId) return response.status(403).json({ message: 'You can only access your own financial data.' });
  return next();
}

const currentUserId = (request: Request) => {
  if (!request.auth) throw new Error('Authenticated user required.');
  return request.auth.userId;
};

type RecordedPayment = { amount: number; date: Date; kind: 'EMI' | 'EXTRA' | 'INTEREST_RENEWAL' };
type ScheduledLoan = { principal: number; interestRate: number; termMonths: number; emi: number; startDate: Date; payments: RecordedPayment[] };

function repaymentProgress(principal: number, interestRate: number, payments: RecordedPayment[]) {
  let balance = principal;
  let principalPaid = 0;
  let interestPaid = 0;
  for (const payment of [...payments].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    if (payment.kind === 'INTEREST_RENEWAL') { interestPaid += payment.amount; continue; }
    const interest = payment.kind === 'EXTRA' ? 0 : Math.round(balance * interestRate / 1200);
    const paidInterest = Math.min(payment.amount, interest);
    const paidPrincipal = Math.min(balance, Math.max(0, payment.amount - paidInterest));
    interestPaid += paidInterest;
    principalPaid += paidPrincipal;
    balance = Math.max(0, balance - paidPrincipal);
  }
  return { balance: Math.round(balance), principalPaid: Math.round(principalPaid), interestPaid: Math.round(interestPaid) };
}

function scheduledProgress(loan: ScheduledLoan) {
  const firstEmi = new Date(loan.startDate); firstEmi.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let paidEmis = 0;
  if (today >= firstEmi) {
    paidEmis = (today.getFullYear() - firstEmi.getFullYear()) * 12 + today.getMonth() - firstEmi.getMonth() + 1;
    if (today.getDate() < firstEmi.getDate()) paidEmis -= 1;
  }
  paidEmis = Math.max(0, Math.min(loan.termMonths, paidEmis));
  let balance = loan.principal;
  let principalPaid = 0;
  let interestPaid = 0;
  if (loan.emi > 0) for (let index = 0; index < paidEmis && balance > 0.5; index++) {
    const interest = Math.round(balance * loan.interestRate / 1200);
    const payment = Math.min(loan.emi, balance + interest);
    const principal = Math.max(0, payment - interest);
    balance = Math.max(0, balance - principal);
    principalPaid += principal;
    interestPaid += interest;
  }
  const extras = loan.payments.filter(payment => payment.kind === 'EXTRA' && payment.date <= today).reduce((sum, payment) => sum + payment.amount, 0);
  const extraPrincipal = Math.min(balance, extras);
  balance = Math.max(0, balance - extraPrincipal);
  principalPaid += extraPrincipal;
  return { paidEmis, remainingEmis: Math.max(0, loan.termMonths - paidEmis), principalPaid: Math.round(principalPaid), interestPaid: Math.round(interestPaid), balance: Math.round(balance), recordedEmis: loan.payments.filter(payment => payment.kind === 'EMI').length };
}

function installmentForMonth(loan: ScheduledLoan, year: number, month: number) {
  const first = new Date(loan.startDate); first.setHours(0, 0, 0, 0);
  const index = (year - first.getFullYear()) * 12 + (month - 1 - first.getMonth());
  if (index < 0 || index >= loan.termMonths) return null;
  const date = new Date(first); date.setMonth(first.getMonth() + index);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1) return null;
  if (loan.emi <= 0) {
    const interest = Math.round(loan.principal * loan.interestRate / 1200);
    return { date, payment: interest, principal: 0, interest, kind: 'INTEREST_RENEWAL' as const };
  }
  let balance = loan.principal;
  let payment = 0;
  let principal = 0;
  let interest = 0;
  for (let step = 0; step <= index && balance > 0.5; step++) {
    interest = Math.round(balance * loan.interestRate / 1200);
    payment = Math.min(loan.emi, balance + interest);
    principal = Math.max(0, payment - interest);
    balance = Math.max(0, balance - principal);
  }
  return { date, payment: Math.round(payment), principal: Math.round(principal), interest: Math.round(interest), kind: 'EMI' as const };
}

type PayoffLoan = { id: string; name: string; balance: number; rate: number; emi: number; remainingEmis: number };
const payoffTarget = (loans: PayoffLoan[], strategy: 'avalanche' | 'snowball') => [...loans].filter(loan => loan.balance > 1).sort((a, b) => strategy === 'avalanche' ? b.rate - a.rate : a.balance - b.balance)[0];
function simulatePayoff(source: PayoffLoan[], strategy: 'avalanche' | 'snowball', extraMonthly = 0, oneTime = 0) {
  const loans = source.map(loan => ({ ...loan, balance: loan.balance }));
  const monthlyCommitment = loans.reduce((sum, loan) => sum + loan.emi, 0);
  let interestPaid = 0;
  let month = 0;
  const closures: Array<{ loanId: string; name: string; month: number; freedEmi: number; monthlyPower: number; redirectedTo: string }> = [];
  const recordClosures = () => {
    for (const loan of loans.filter(item => item.balance <= 1 && !closures.some(closure => closure.loanId === item.id))) {
      const next = payoffTarget(loans, strategy);
      const monthlyPower = extraMonthly + closures.reduce((sum, closure) => sum + closure.freedEmi, 0) + loan.emi;
      closures.push({ loanId: loan.id, name: loan.name, month, freedEmi: Math.round(loan.emi), monthlyPower: Math.round(monthlyPower), redirectedTo: next?.name || 'Your debt-free finish' });
    }
  };
  if (oneTime > 0) { const target = payoffTarget(loans, strategy); if (target) target.balance = Math.max(0, target.balance - oneTime); recordClosures(); }
  while (loans.some(loan => loan.balance > 1) && month < 600) {
    month += 1;
    let spent = 0;
    for (const loan of loans.filter(item => item.balance > 1)) {
      const interest = loan.balance * loan.rate / 1200;
      interestPaid += interest;
      const payment = Math.min(loan.emi, loan.balance + interest);
      spent += payment;
      loan.balance = Math.max(0, loan.balance + interest - payment);
    }
    const cascadeBudget = Math.max(0, monthlyCommitment + extraMonthly - spent);
    const target = payoffTarget(loans, strategy);
    if (target && cascadeBudget > 0) target.balance = Math.max(0, target.balance - cascadeBudget);
    recordClosures();
  }
  return { strategy, months: month, interestPaid: Math.round(interestPaid), monthlyCommitment: Math.round(monthlyCommitment), closures, unresolvedLoans: loans.filter(loan => loan.balance > 1).map(loan => loan.name) };
}

const csv = (headers: string[], rows: Array<Array<string | number | Date | null>>) => [headers.join(','), ...rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
const cloudKey = (path: string) => s3Bucket && path.startsWith(`s3://${s3Bucket}/`) ? path.slice(`s3://${s3Bucket}/`.length) : null;
async function storeDocument(file: Express.Multer.File, userId: string) {
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${userId}/${Date.now()}-${safeName}`;
  if (s3 && s3Bucket) {
    await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: file.buffer, ContentType: file.mimetype }));
    return `s3://${s3Bucket}/${key}`;
  }
  if (isProduction) throw new Error('Cloud document storage is not configured.');
  const localPath = join(localVaultPath, key);
  mkdirSync(dirname(localPath), { recursive: true });
  await writeFile(localPath, file.buffer);
  return localPath;
}

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) return callback(null, true); return callback(new Error('This origin is not allowed to call the Nivara API.')); } }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many sign-in attempts. Please try again later.' } });

app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.post('/api/auth/signup', authLimiter, async (request, response) => {
  const data = authSchema.extend({ name: z.string().min(2).max(80) }).parse(request.body);
  const exists = await db.user.findUnique({ where: { email: data.email } });
  if (exists) return response.status(409).json({ message: 'An account with this email already exists.' });
  const user = await db.user.create({ data: { name: data.name, email: data.email, passwordHash: await bcrypt.hash(data.password, 12) } });
  return response.status(201).json({ token: tokenFor(user), user: publicUser(user) });
});
app.post('/api/auth/login', authLimiter, async (request, response) => {
  const data = authSchema.parse(request.body);
  const user = await db.user.findUnique({ where: { email: data.email } });
  if (!user?.passwordHash || !await bcrypt.compare(data.password, user.passwordHash)) return response.status(401).json({ message: 'Email or password is incorrect.' });
  return response.json({ token: tokenFor(user), user: publicUser(user) });
});
app.post('/api/auth/google', authLimiter, async (request, response) => {
  const { credential } = z.object({ credential: z.string().min(1) }).parse(request.body);
  if (!process.env.GOOGLE_CLIENT_ID) return response.status(503).json({ message: 'Google sign-in has not been configured yet.' });
  const ticket = await google.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const profile = ticket.getPayload();
  if (!profile?.email || !profile.sub) return response.status(401).json({ message: 'Google could not verify this account.' });
  const user = await db.user.upsert({ where: { email: profile.email }, update: { googleId: profile.sub, name: profile.name || profile.email, avatarUrl: profile.picture }, create: { email: profile.email, googleId: profile.sub, name: profile.name || profile.email, avatarUrl: profile.picture } });
  return response.json({ token: tokenFor(user), user: publicUser(user) });
});

app.get('/api/loans', requireAuth, async (request, response) => {
  const loans = await db.loan.findMany({ where: { userId: currentUserId(request) }, include: { payments: true }, orderBy: { createdAt: 'desc' } });
  return response.json(loans.map(loan => ({ ...loan, calculatedOutstanding: scheduledProgress(loan).balance, automaticProgress: scheduledProgress(loan) })));
});
app.post('/api/loans', requireAuth, async (request, response) => response.status(201).json(await db.loan.create({ data: { ...loanSchema.parse(request.body), userId: currentUserId(request) } })));
app.put('/api/loans/:id', requireAuth, async (request, response) => {
  const existing = await db.loan.findFirst({ where: { id: String(request.params.id), userId: currentUserId(request) }, include: { payments: true } });
  if (!existing) return response.status(404).json({ message: 'Loan not found.' });
  const data = loanSchema.parse(request.body);
  const outstanding = existing.payments.length ? repaymentProgress(data.principal, data.interestRate, existing.payments).balance : data.principal;
  return response.json(await db.loan.update({ where: { id: existing.id }, data: { ...data, outstanding } }));
});
app.get('/api/calendar', requireAuth, async (request, response) => {
  const months = Math.min(Math.max(Number(request.query.months) || 3, 1), 24);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + months, 0, 23, 59, 59, 999);
  const loans = await db.loan.findMany({ where: { userId: currentUserId(request) }, include: { payments: true } });
  const events = loans.flatMap(loan => {
    const items: Array<{ id: string; loanId: string; loanName: string; date: string; amount: number; kind: 'EMI' | 'INTEREST_RENEWAL'; status: 'paid' | 'due' | 'upcoming' | 'overdue'; paymentId: string | null }> = [];
    const first = new Date(loan.startDate); first.setHours(0, 0, 0, 0);
    for (let index = 0; index < loan.termMonths; index++) {
      const date = new Date(first); date.setMonth(first.getMonth() + index);
      if (date < now || date > end) continue;
      const interestOnly = loan.emi === 0;
      const kind = interestOnly ? 'INTEREST_RENEWAL' : 'EMI';
      const amount = interestOnly ? Math.round(loan.outstanding * loan.interestRate / 1200) : loan.emi;
      const payment = loan.payments.find(item => item.kind === kind && item.date.getFullYear() === date.getFullYear() && item.date.getMonth() === date.getMonth());
      const days = Math.floor((date.getTime() - now.getTime()) / 86400000);
      items.push({ id: `${loan.id}-${date.toISOString().slice(0, 7)}`, loanId: loan.id, loanName: loan.name, date: date.toISOString(), amount, kind, status: payment ? 'paid' : days < 0 ? 'overdue' : days <= 7 ? 'due' : 'upcoming', paymentId: payment?.id ?? null });
    }
    return items;
  }).sort((a, b) => a.date.localeCompare(b.date));
  return response.json({ events });
});
app.get('/api/loans/:id/amortization', requireAuth, async (request, response) => {
  const loan = await db.loan.findFirst({ where: { id: String(request.params.id), userId: currentUserId(request) }, include: { payments: true } });
  if (!loan) return response.status(404).json({ message: 'Loan not found.' });
  const progress = scheduledProgress(loan);
  const fullSchedule = String(request.query.full) === 'true';
  const months = fullSchedule ? loan.termMonths : progress.remainingEmis;
  if (loan.emi <= 0) {
    const balance = fullSchedule ? loan.principal : progress.balance;
    const monthlyInterest = Math.round(balance * loan.interestRate / 1200);
    const schedule = Array.from({ length: months }, (_, index) => ({ month: fullSchedule ? index + 1 : progress.paidEmis + index + 1, payment: monthlyInterest, principal: 0, interest: monthlyInterest, balance }));
    return response.json({ loanId: loan.id, interestOnly: true, monthlyInterest, schedule, fullSchedule, totalMonths: loan.termMonths, completedMonths: progress.paidEmis, remainingMonths: progress.remainingEmis });
  }
  const monthlyRate = loan.interestRate / 1200;
  let balance = fullSchedule ? loan.principal : progress.balance;
  const schedule: Array<{ month: number; payment: number; principal: number; interest: number; balance: number }> = [];
  for (let month = 1; month <= months && balance > 0.5; month++) {
    const interest = Math.round(balance * monthlyRate);
    const payment = Math.min(loan.emi, balance + interest);
    const principal = Math.max(0, payment - interest);
    balance = Math.max(0, balance - principal);
    schedule.push({ month: fullSchedule ? month : progress.paidEmis + month, payment, principal, interest, balance: Math.round(balance) });
  }
  const totals = schedule.reduce((sum, item) => ({ interest: sum.interest + item.interest, principal: sum.principal + item.principal }), { interest: 0, principal: 0 });
  return response.json({ loanId: loan.id, interestOnly: false, monthlyRate, schedule, totals, fullSchedule, totalMonths: loan.termMonths, completedMonths: progress.paidEmis, remainingMonths: progress.remainingEmis });
});
app.post('/api/loans/:id/payments', requireAuth, async (request, response) => {
  const paymentData = z.object({ amount: z.number().positive(), date: z.coerce.date(), kind: z.enum(['EMI', 'EXTRA', 'INTEREST_RENEWAL']) }).parse(request.body);
  const loan = await db.loan.findFirst({ where: { id: String(request.params.id), userId: currentUserId(request) }, include: { payments: true } });
  if (!loan) return response.status(404).json({ message: 'Loan not found.' });
  const payment = await db.$transaction(async transaction => {
    const created = await transaction.payment.create({ data: { ...paymentData, loanId: loan.id } });
    const balance = repaymentProgress(loan.principal, loan.interestRate, [...loan.payments, created]).balance;
    await transaction.loan.update({ where: { id: loan.id }, data: { outstanding: balance } });
    return created;
  });
  return response.status(201).json(payment);
});
app.delete('/api/loans/:loanId/payments/:paymentId', requireAuth, async (request, response) => {
  const loan = await db.loan.findFirst({ where: { id: String(request.params.loanId), userId: currentUserId(request) }, include: { payments: true } });
  const payment = loan?.payments.find(item => item.id === String(request.params.paymentId));
  if (!loan || !payment) return response.status(404).json({ message: 'Payment not found for this loan.' });
  await db.$transaction(async transaction => {
    await transaction.payment.delete({ where: { id: payment.id } });
    const balance = repaymentProgress(loan.principal, loan.interestRate, loan.payments.filter(item => item.id !== payment.id)).balance;
    await transaction.loan.update({ where: { id: loan.id }, data: { outstanding: balance } });
  });
  return response.status(204).end();
});

app.get('/api/payoff/compare', requireAuth, async (request, response) => {
  const extraMonthly = Math.max(0, Number(request.query.extraMonthly) || 0);
  const oneTime = Math.max(0, Number(request.query.oneTime) || 0);
  const records = await db.loan.findMany({ where: { userId: currentUserId(request) }, include: { payments: true } });
  const startingLoans = records.map(loan => { const progress = scheduledProgress(loan); return { id: loan.id, name: loan.name, balance: progress.balance, rate: loan.interestRate, emi: loan.emi || Math.ceil(progress.balance * loan.interestRate / 1200), remainingEmis: progress.remainingEmis }; }).filter(loan => loan.balance > 1);
  const avalanche = simulatePayoff(startingLoans, 'avalanche', extraMonthly, oneTime);
  const snowball = simulatePayoff(startingLoans, 'snowball', extraMonthly, oneTime);
  return response.json({ extraMonthly, oneTime, startingLoans: startingLoans.map(loan => ({ ...loan, balance: Math.round(loan.balance) })), avalanche, snowball, recommendation: avalanche.interestPaid <= snowball.interestPaid ? 'avalanche' : 'snowball', interestSaved: Math.abs(avalanche.interestPaid - snowball.interestPaid), monthsDifference: Math.abs(avalanche.months - snowball.months) });
});

app.get('/api/users/:userId/financial-profile', requireAuth, requireCurrentUser, async (request, response) => response.json({ profile: await db.financialProfile.findUnique({ where: { userId: currentUserId(request) } }) }));
app.put('/api/users/:userId/financial-profile', requireAuth, requireCurrentUser, async (request, response) => response.json(await db.financialProfile.upsert({ where: { userId: currentUserId(request) }, update: profileSchema.parse(request.body), create: { userId: currentUserId(request), ...profileSchema.parse(request.body) } })));
app.get('/api/users/:userId/affordability', requireAuth, requireCurrentUser, async (request, response) => {
  const userId = currentUserId(request);
  const profile = await db.financialProfile.findUnique({ where: { userId } });
  if (!profile) return response.json({ configured: false });
  const emi = (await db.loan.aggregate({ where: { userId }, _sum: { emi: true } }))._sum.emi || 0;
  const available = profile.monthlyIncome - profile.essentialExpenses - profile.monthlySavings - emi;
  return response.json({ configured: true, monthlyIncome: profile.monthlyIncome, essentialExpenses: profile.essentialExpenses, monthlySavings: profile.monthlySavings, monthlyEmi: emi, availableForExtraPayment: Math.max(0, available), emiToIncomePercent: profile.monthlyIncome ? Math.round(emi / profile.monthlyIncome * 100) : 0, emergencyFundMonths: profile.essentialExpenses ? Number((profile.emergencyFund / profile.essentialExpenses).toFixed(1)) : 0 });
});
app.get('/api/safeguards', requireAuth, async (request, response) => {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const loans = await db.loan.findMany({ where: { userId: currentUserId(request), kind: { in: [LoanKind.JEWEL, LoanKind.OVERDRAFT] } } });
  const alerts = loans.map(loan => {
    const start = new Date(loan.startDate);
    const isJewel = loan.kind === LoanKind.JEWEL;
    const due = isJewel ? new Date(start.getFullYear() + 1, start.getMonth(), loan.paymentDueDay) : new Date(now.getFullYear(), now.getMonth() + 1, loan.paymentDueDay);
    if (!isJewel && due < now) due.setMonth(due.getMonth() + 1);
    const daysRemaining = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    const amount = Math.round(loan.outstanding * loan.interestRate / (isJewel ? 100 : 1200));
    return { loanId: loan.id, loanName: loan.name, kind: loan.kind, dueDate: due.toISOString(), daysRemaining, amount, action: isJewel ? 'Pay annual interest to renew' : 'Pay this month’s overdraft interest', severity: daysRemaining <= 7 ? 'critical' : daysRemaining <= 30 ? 'warning' : 'info' };
  }).sort((a, b) => a.daysRemaining - b.daysRemaining);
  return response.json({ alerts });
});
app.get('/api/users/:userId/stress-score', requireAuth, requireCurrentUser, async (request, response) => {
  const userId = currentUserId(request);
  const profile = await db.financialProfile.findUnique({ where: { userId } });
  const loans = await db.loan.findMany({ where: { userId } });
  const emi = loans.reduce((sum, loan) => sum + (loan.emi || loan.outstanding * loan.interestRate / 1200), 0);
  const highInterestLoans = loans.filter(loan => loan.interestRate >= 14).length;
  const totalOutstanding = loans.reduce((sum, loan) => sum + loan.outstanding, 0);
  if (!profile) return response.json({ configured: false, score: null, actions: ['Add your income, expenses, savings, and emergency fund to calculate a personal score.'] });
  const ratio = profile.monthlyIncome ? emi / profile.monthlyIncome : 1;
  const emergencyMonths = profile.essentialExpenses ? profile.emergencyFund / profile.essentialExpenses : 0;
  let score = 100;
  const actions: string[] = [];
  if (ratio > .5) { score -= 35; actions.push('EMIs exceed 50% of income—avoid new borrowing and reduce high-interest debt first.'); } else if (ratio > .35) { score -= 18; actions.push('Keep extra payments focused on high-interest loans until EMI pressure falls below 35%.'); } else actions.push('Your EMI-to-income ratio is within a manageable range.');
  if (emergencyMonths < 1) { score -= 18; actions.push('Build a one-month emergency buffer before making aggressive extra payments.'); } else if (emergencyMonths < 3) { score -= 8; actions.push('Continue building toward a three-month emergency buffer.'); } else actions.push('Your emergency buffer is providing useful stability.');
  if (highInterestLoans) { score -= highInterestLoans * 7; actions.push(`Prioritize ${highInterestLoans} high-interest loan${highInterestLoans > 1 ? 's' : ''} to reduce interest stress.`); }
  if (totalOutstanding > profile.monthlyIncome * 24) { score -= 8; actions.push('Your outstanding balance is high relative to income; use the payoff cascade consistently.'); }
  score = Math.max(0, Math.round(score));
  return response.json({ configured: true, score, level: score >= 75 ? 'steady' : score >= 50 ? 'watchful' : 'high pressure', metrics: { emiToIncomePercent: Math.round(ratio * 100), emergencyFundMonths: Number(emergencyMonths.toFixed(1)), highInterestLoans, totalOutstanding }, actions });
});

app.get('/api/users/:userId/documents', requireAuth, requireCurrentUser, async (request, response) => response.json(await db.document.findMany({ where: { userId: currentUserId(request) }, orderBy: { createdAt: 'desc' } })));
app.post('/api/users/:userId/documents', requireAuth, requireCurrentUser, upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ message: 'Upload a PDF, PNG, or JPG file up to 10 MB.' });
  const userId = currentUserId(request);
  const loanId = typeof request.body.loanId === 'string' && request.body.loanId ? request.body.loanId : null;
  if (loanId && !await db.loan.findFirst({ where: { id: loanId, userId } })) return response.status(404).json({ message: 'Loan not found.' });
  const path = await storeDocument(request.file, userId);
  const document = await db.document.create({ data: { userId, loanId, name: request.file.originalname, mimeType: request.file.mimetype, sizeBytes: request.file.size, path } });
  return response.status(201).json(document);
});
app.get('/api/users/:userId/documents/:documentId/download', requireAuth, requireCurrentUser, async (request, response) => {
  const document = await db.document.findFirst({ where: { id: String(request.params.documentId), userId: currentUserId(request) } });
  if (!document) return response.status(404).json({ message: 'Document not found.' });
  const key = cloudKey(document.path);
  if (key && s3 && s3Bucket) return response.json({ url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: s3Bucket, Key: key, ResponseContentDisposition: `attachment; filename="${document.name.replace(/"/g, '')}"` }), { expiresIn: 60 }), expiresIn: 60 });
  if (!existsSync(document.path)) return response.status(404).json({ message: 'The stored document could not be found.' });
  return response.download(document.path, document.name);
});

app.get('/api/reviews/monthly', requireAuth, async (request, response) => {
  const requested = typeof request.query.month === 'string' ? request.query.month : undefined;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const [year, month] = requested?.match(/^\d{4}-\d{2}$/) ? requested.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const loans = await db.loan.findMany({ where: { userId: currentUserId(request) }, include: { payments: true } });
  const schedule = loans.flatMap(loan => {
    const installment = installmentForMonth(loan, year, month);
    if (!installment) return [];
    const confirmed = loan.payments.some(payment => payment.kind === installment.kind && payment.date.getFullYear() === year && payment.date.getMonth() === month - 1);
    return [{ loanId: loan.id, loanName: loan.name, ...installment, status: confirmed ? 'confirmed' : installment.date <= now ? 'counted' : 'upcoming' }];
  });
  const payments = loans.flatMap(loan => loan.payments.filter(payment => payment.date >= start && payment.date < end).map(payment => ({ ...payment, loanName: loan.name })));
  const extraPaid = payments.filter(payment => payment.kind === 'EXTRA').reduce((sum, payment) => sum + payment.amount, 0);
  const dueSchedule = schedule.filter(item => item.date <= now);
  const confirmedEmis = payments.filter(payment => payment.kind === 'EMI' || payment.kind === 'INTEREST_RENEWAL').length;
  const scheduledAmount = schedule.reduce((sum, item) => sum + item.payment, 0);
  const scheduledInterest = dueSchedule.reduce((sum, item) => sum + item.interest, 0);
  const scheduledPrincipal = dueSchedule.reduce((sum, item) => sum + item.principal, 0);
  const active = loans.map(loan => ({ loan, balance: scheduledProgress(loan).balance })).filter(item => item.balance > 0).sort((a, b) => b.loan.interestRate - a.loan.interestRate)[0];
  const countedEmis = dueSchedule.length;
  const message = !schedule.length ? `There are no scheduled loan payments in ${start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}.` : countedEmis ? `${countedEmis} scheduled payment${countedEmis === 1 ? ' was' : 's were'} counted from your first EMI dates.${confirmedEmis ? ` ${confirmedEmis} ${confirmedEmis === 1 ? 'is' : 'are'} also confirmed in the calendar.` : ' Confirm them in Calendar when you have paid the lender.'}` : `${schedule.length} payment${schedule.length === 1 ? ' is' : 's are'} planned later this month.`;
  return response.json({ month: `${year}-${String(month).padStart(2, '0')}`, scheduledAmount: Math.round(scheduledAmount), scheduledEmis: schedule.length, countedEmis, confirmedEmis, extraPaid: Math.round(extraPaid), estimatedInterestPaid: Math.round(scheduledInterest), debtReduction: Math.round(scheduledPrincipal + extraPaid), nextBestMove: active ? `Prioritize ${active.loan.name} at ${active.loan.interestRate}% interest.` : 'Add your first loan to create a tailored next step.', message, schedule: schedule.map(item => ({ ...item, date: item.date.toISOString() })) });
});

app.get('/api/exports/loans.csv', requireAuth, async (request, response) => {
  const loans = await db.loan.findMany({ where: { userId: currentUserId(request) }, include: { payments: true } });
  return response.type('text/csv').attachment('nivara-loans.csv').send(csv(['Name', 'Type', 'Principal', 'Outstanding', 'Rate %', 'EMI', 'Start date', 'Payments'], loans.map(loan => [loan.name, loan.kind, loan.principal, loan.outstanding, loan.interestRate, loan.emi, loan.startDate.toISOString().slice(0, 10), loan.payments.length])));
});
app.get('/api/exports/payments.csv', requireAuth, async (request, response) => {
  const payments = await db.payment.findMany({ where: { loan: { userId: currentUserId(request) } }, include: { loan: true }, orderBy: { date: 'desc' } });
  return response.type('text/csv').attachment('nivara-payments.csv').send(csv(['Date', 'Loan', 'Payment type', 'Amount'], payments.map(payment => [payment.date.toISOString().slice(0, 10), payment.loan.name, payment.kind, payment.amount])));
});
app.get('/api/backups/latest.json', requireAuth, async (request, response) => {
  const userId = currentUserId(request);
  const [loans, payments, financialProfile, documents] = await Promise.all([db.loan.findMany({ where: { userId } }), db.payment.findMany({ where: { loan: { userId } } }), db.financialProfile.findUnique({ where: { userId } }), db.document.findMany({ where: { userId }, select: { id: true, userId: true, loanId: true, name: true, mimeType: true, sizeBytes: true, createdAt: true } })]);
  return response.attachment('nivara-backup.json').json({ version: 1, exportedAt: new Date().toISOString(), loans, payments, financialProfile, documents });
});

app.get('/api/users/:userId/family-shares', requireAuth, requireCurrentUser, async (request, response) => response.json(await db.familyShare.findMany({ where: { ownerId: currentUserId(request) }, include: { recipient: { select: { id: true, name: true, email: true, avatarUrl: true } } }, orderBy: { createdAt: 'desc' } })));
app.post('/api/users/:userId/family-shares', requireAuth, requireCurrentUser, async (request, response) => {
  const data = z.object({ email: z.string().email(), role: z.enum(['VIEWER', 'EDITOR']).default('VIEWER') }).parse(request.body);
  const recipient = await db.user.findUnique({ where: { email: data.email } });
  const share = await db.familyShare.upsert({ where: { ownerId_email: { ownerId: currentUserId(request), email: data.email } }, update: { role: data.role, recipientId: recipient?.id, status: recipient ? 'ACTIVE' : 'PENDING' }, create: { ownerId: currentUserId(request), email: data.email, role: data.role, recipientId: recipient?.id, status: recipient ? 'ACTIVE' : 'PENDING' } });
  return response.status(201).json(share);
});
app.delete('/api/users/:userId/family-shares/:shareId', requireAuth, requireCurrentUser, async (request, response) => {
  const share = await db.familyShare.findFirst({ where: { id: String(request.params.shareId), ownerId: currentUserId(request) } });
  if (!share) return response.status(404).json({ message: 'Family invitation not found.' });
  await db.familyShare.delete({ where: { id: share.id } });
  return response.status(204).end();
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (error instanceof z.ZodError) return response.status(400).json({ message: 'Please check the values you entered.' });
  if (error instanceof multer.MulterError) return response.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Document size must be 10 MB or less.' : 'Document upload failed.' });
  const message = error instanceof Error && error.message.includes('not allowed') ? error.message : isProduction ? 'Something went wrong. Please try again.' : error instanceof Error ? error.message : 'Something went wrong.';
  return response.status(error instanceof Error && error.message.includes('not allowed') ? 403 : 500).json({ message });
});

app.listen(Number(process.env.PORT || 4000), () => console.log(`Nivara API listening on :${process.env.PORT || 4000}`));
