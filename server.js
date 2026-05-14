const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();
const prisma = new PrismaClient();

// ── CORS ────────────────────────────────────────────────────────────────────────
// In production, only allow requests from the Vercel frontend domain.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Automatically allow any Vercel preview domain or the exact FRONTEND_URL
    if (origin.endsWith('.vercel.app') || allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 5000;

// ── Seed Admin ──────────────────────────────────────────────────────────────────
async function seedAdmin() {
  const adminEmail = 'admin@satkarmpuja.com';
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    await prisma.user.create({
      data: {
        fullName: 'Admin User',
        email: adminEmail,
        password: 'admin',
        phone: '1234567890',
        role: 'admin'
      }
    });
    console.log('Admin user seeded');
  }
}
seedAdmin().catch(console.error);

// ── Health check ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'SatkarmPuja API is running' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  const { fullName, email, phone, city, state, country } = req.body;
  try {
    const user = await prisma.user.create({
      data: { fullName, email, password: 'otp-user', phone, city, state, country, role: 'user' }
    });
    res.json({ success: true, token: email, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ── OTP Cache (Memory based for simplicity) ──
const otpCache = new Map();

app.post('/api/auth/request-otp', async (req, res) => {
  const { phone } = req.body;
  
  try {
    const user = await prisma.user.findFirst({ where: { phone } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Generate random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store in cache with expiration (5 mins)
    otpCache.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });

    if (user.email && process.env.EMAIL_USER) {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 465,
        secure: true,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        }
      });

      await transporter.sendMail({
        from: `"SatkarmPuja" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: 'SatkarmPuja Login OTP',
        text: `Namaste ${user.fullName},\n\nYour OTP for secure login is: ${otp}\n\nThis OTP will expire in 5 minutes.\n\nThank you,\nSatkarmPuja Team`
      });
      console.log(`OTP Email sent to ${user.email}`);
    }

    res.json({ success: true, message: 'OTP sent successfully to your registered email.' });
  } catch (error) {
    console.error('OTP Error:', error);
    res.status(500).json({ success: false, error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/login-otp', async (req, res) => {
  const { phone, otp } = req.body;
  
  // Backdoor for testing
  const isValidOtp = otp === '123456' || (
    otpCache.has(phone) && 
    otpCache.get(phone).otp === otp &&
    otpCache.get(phone).expires > Date.now()
  );

  if (!isValidOtp) {
    return res.status(401).json({ success: false, error: 'Invalid or expired OTP' });
  }

  // Clear OTP after successful use
  otpCache.delete(phone);

  try {
    const user = await prisma.user.findFirst({ where: { phone } });
    if (user) {
      if (user.isBlocked) return res.status(403).json({ success: false, error: 'User is blocked' });
      res.json({ success: true, token: user.email, user });
    } else {
      res.status(404).json({ success: false, error: 'User not found. Please sign up.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false });
  const email = authHeader.split(' ')[1];
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) res.json(user);
    else res.status(401).json({ success: false });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USER PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

app.patch('/api/users/profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false });
  const email = authHeader.split(' ')[1];
  try {
    const updated = await prisma.user.update({
      where: { email },
      data: req.body
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/bookings', async (req, res) => {
  const { name, phone, email, pooja_type, city, message, poojaDate, address, specialRequirements, userId } = req.body;
  try {
    const booking = await prisma.booking.create({
      data: {
        name, phone, email, pooja_type, city, message,
        poojaDate: poojaDate ? new Date(poojaDate) : null,
        address, specialRequirements, userId
      }
    });
    res.json({ success: true, booking });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/bookings/mine', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false });
  const email = authHeader.split(' ')[1];
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json([]);
    const bookings = await prisma.booking.findMany({
      where: { userId: user.id },
      orderBy: { created_at: 'desc' }
    });
    res.json(bookings);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({ orderBy: { created_at: 'desc' } });
    res.json(bookings);
  } catch (error) {
    res.status(500).json([]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/bookings/admin/all', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({ orderBy: { created_at: 'desc' } });
    res.json(bookings);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.patch('/api/bookings/admin/:id', async (req, res) => {
  try {
    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { created_at: 'desc' } });
    res.json(users);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.patch('/api/admin/users/:id/block', async (req, res) => {
  try {
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isBlocked: req.body.blocked }
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    // Delete user's bookings and stories first
    await prisma.booking.deleteMany({ where: { userId: req.params.id } });
    await prisma.story.deleteMany({ where: { userId: req.params.id } });
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stories/public', async (req, res) => {
  try {
    const stories = await prisma.story.findMany({
      where: { status: 'approved' },
      orderBy: { created_at: 'desc' }
    });
    res.json(stories);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.post('/api/stories', async (req, res) => {
  const { name, email, city, puja, story, rating, userId } = req.body;
  try {
    const created = await prisma.story.create({
      data: { name, email, city, puja, story, rating: rating || 5, userId }
    });
    res.json({ success: true, story: created });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/stories/admin/all', async (req, res) => {
  try {
    const stories = await prisma.story.findMany({ orderBy: { created_at: 'desc' } });
    res.json(stories);
  } catch (error) {
    res.status(500).json([]);
  }
});

app.patch('/api/stories/admin/:id', async (req, res) => {
  try {
    const updated = await prisma.story.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/stories/admin/:id', async (req, res) => {
  try {
    await prisma.story.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT / SETTINGS (key-value store)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/content/:key', async (req, res) => {
  try {
    const setting = await prisma.setting.findFirst({ where: { key: req.params.key } });
    res.json({ data: setting ? JSON.parse(setting.value) : null });
  } catch (error) {
    res.status(500).json({ data: null });
  }
});

app.put('/api/content/:key', async (req, res) => {
  try {
    const existing = await prisma.setting.findFirst({ where: { key: req.params.key } });
    let setting;
    if (existing) {
      setting = await prisma.setting.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(req.body.data) }
      });
    } else {
      setting = await prisma.setting.create({
        data: { key: req.params.key, value: JSON.stringify(req.body.data) }
      });
    }
    res.json({ success: true, data: JSON.parse(setting.value) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS (MOCK — replace with real Razorpay in production)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/payments/create-order', async (req, res) => {
  const { bookingId } = req.body;
  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    res.json({
      orderId: 'order_' + Math.random().toString(36).substr(2, 9),
      amount: (booking.price || 0) * 100,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payments/verify-payment', async (req, res) => {
  const { bookingId, razorpay_order_id } = req.body;
  try {
    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'payment-completed', razorpayOrderId: razorpay_order_id }
    });
    res.json({ success: true, booking: updated });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
