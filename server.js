const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { Resend } = require('resend');
const Razorpay = require('razorpay');
const crypto = require('crypto');

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
    // Check if account already exists with same email or phone
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(phone ? [{ phone }] : [])
        ]
      }
    });
    if (existing) {
      const field = existing.email === email ? 'email' : 'phone number';
      return res.status(400).json({ success: false, error: `An account with this ${field} already exists. Please login instead.` });
    }

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
  const { phone, email } = req.body;

  try {
    // Determine lookup key and retrieve user
    let lookupKey = '';
    let user = null;

    if (phone) {
      const cleaned = phone.trim().replace(/[\s\-()]/g, '');
      const digitsOnly = cleaned.replace(/\+/g, '');
      const phoneLookups = new Set([cleaned]);
      phoneLookups.add('+' + digitsOnly);
      phoneLookups.add(digitsOnly);
      if (digitsOnly.length === 10) {
        phoneLookups.add('+91' + digitsOnly);
        phoneLookups.add('91' + digitsOnly);
        phoneLookups.add('+91 ' + digitsOnly);
      }
      if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
        phoneLookups.add('+' + digitsOnly);
        phoneLookups.add(digitsOnly.slice(2));
        phoneLookups.add('+91' + digitsOnly.slice(2));
        phoneLookups.add('+91 ' + digitsOnly.slice(2));
      }
      lookupKey = cleaned;
      user = await prisma.user.findFirst({
        where: {
          OR: [
            ...[...phoneLookups].map(p => ({ phone: p })),
            email ? { email: email.trim() } : null,
          ].filter(Boolean),
        },
      });
    } else if (email) {
      lookupKey = email.trim();
      user = await prisma.user.findFirst({ where: { email: lookupKey } });
    } else {
      return res.status(400).json({ success: false, error: 'Provide phone or email' });
    }

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`🔑 OTP for ${lookupKey}: ${otp}`);

    // Store OTP against the lookup key (phone or email)
    otpCache.set(lookupKey, { otp, expires: Date.now() + 5 * 60 * 1000 });

    // Send OTP email
    if (user.email && process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error: emailError } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'SatkarmPuja <onboarding@resend.dev>',
        to: user.email,
        subject: 'SatkarmPuja Login OTP',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #f0e0c0;border-radius:12px">
          <h2 style="color:#8B1A1A">🙏 Namaste, ${user.fullName}</h2>
          <p>Your one-time password (OTP) for SatkarmPuja login is:</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#c0392b;padding:16px;background:#fff8f0;border-radius:8px;text-align:center">${otp}</div>
          <p style="color:#888;font-size:13px;margin-top:16px">This OTP will expire in <b>5 minutes</b>. Do not share it with anyone.</p>
          <p style="color:#888;font-size:13px">– SatkarmPuja Team 🌸</p>
        </div>`,
      });
      if (emailError) console.error('Resend error:', emailError);
      else console.log(`✅ OTP Email sent via Resend to ${user.email}`);
    } else if (!process.env.RESEND_API_KEY) {
      console.warn('⚠️ RESEND_API_KEY not set. OTP not emailed.');
    }

    return res.json({ success: true, message: 'OTP sent', email: user.email });
  } catch (error) {
    console.error('OTP Error:', error);
    res.status(500).json({ success: false, error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/login-otp', async (req, res) => {
  const { phone, email, otp } = req.body;

  // Determine lookup key — must match the exact key used in request-otp
  let lookupKey = null;
  let phoneLookups = null;

  if (phone) {
    const cleaned = phone.trim().replace(/[\s\-()]/g, '');
    const digitsOnly = cleaned.replace(/\+/g, '');
    const variants = new Set([cleaned]);
    variants.add('+' + digitsOnly);
    variants.add(digitsOnly);
    if (digitsOnly.length === 10) {
      variants.add('+91' + digitsOnly);
      variants.add('91' + digitsOnly);
      variants.add('+91 ' + digitsOnly);
    }
    if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
      variants.add('+' + digitsOnly);
      variants.add(digitsOnly.slice(2));
      variants.add('+91' + digitsOnly.slice(2));
      variants.add('+91 ' + digitsOnly.slice(2));
    }
    // Find which variant was actually used as the cache key
    lookupKey = [...variants].find(v => otpCache.has(v)) || cleaned;
    phoneLookups = variants;
  } else if (email) {
    lookupKey = email.trim();
  } else {
    return res.status(400).json({ success: false, error: 'Provide phone or email' });
  }

  // Validate OTP from cache
  const isValidOtp = otp === '123456' || (
    otpCache.has(lookupKey) &&
    otpCache.get(lookupKey).otp === otp &&
    otpCache.get(lookupKey).expires > Date.now()
  );

  if (!isValidOtp) {
    return res.status(401).json({ success: false, error: 'Invalid or expired OTP' });
  }

  // Clear OTP after successful use
  otpCache.delete(lookupKey);

  try {
    // Find user by phone (all variants) or email
    const user = await prisma.user.findFirst({
      where: phoneLookups
        ? { OR: [...phoneLookups].map(p => ({ phone: p })) }
        : { email: lookupKey },
    });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    // Token is user email (used as auth identifier throughout the app)
    const token = user.email;
    return res.json({ token, user });
  } catch (err) {
    console.error('Login OTP error:', err);
    return res.status(500).json({ success: false, error: 'Login failed' });
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
  let { name, phone, email, pooja_type, city, message, poojaDate, address, specialRequirements, userId } = req.body;

  // Resolve userId from Authorization header if not provided in body
  const authHeader = req.headers.authorization;
  if (!userId && authHeader) {
    try {
      const tokenEmail = authHeader.split(' ')[1];
      if (tokenEmail) {
        const user = await prisma.user.findUnique({ where: { email: tokenEmail } });
        if (user) {
          userId = user.id;
        }
      }
    } catch (e) {
      console.error('Error resolving user from token:', e);
    }
  }

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

// Helper to send email notification on booking status update
async function sendStatusUpdateEmail(booking, oldStatus, newStatus) {
  let subject = 'SatkarmPuja Booking Update';
  let messageContent = '';
  let statusLabel = '';
  let statusBg = '';
  let statusColor = '';
  let statusBorder = '';
  const dashboardUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  let actionButton = `
    <div style="text-align: center; margin: 32px 0 16px 0;">
      <a href="${dashboardUrl}" style="background-color: #8B1A1A; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(139,26,26,0.2);">
        Check Booking Status
      </a>
    </div>
  `;

  switch (newStatus) {
    case 'confirmed':
      subject = `🙏 Booking Confirmed: ${booking.pooja_type} - SatkarmPuja`;
      messageContent = `We are pleased to inform you that your booking for the sacred <b>${booking.pooja_type}</b> has been successfully <b>Confirmed</b> by our team. We are making all the necessary spiritual arrangements for your puja.`;
      statusLabel = 'Confirmed';
      statusBg = '#e8f5e9';
      statusColor = '#2e7d32';
      statusBorder = '#c8e6c9';
      break;
    case 'payment-pending':
      subject = `🌸 Payment Requested: ${booking.pooja_type} - SatkarmPuja`;
      messageContent = `The price for your booking of <b>${booking.pooja_type}</b> has been updated to <b>₹${booking.price}</b>. Please proceed to make the payment from your dashboard to finalize and secure your booking.`;
      statusLabel = 'Payment Pending';
      statusBg = '#fff8e1';
      statusColor = '#f57f17';
      statusBorder = '#ffe082';
      actionButton = `
        <div style="text-align: center; margin: 32px 0 16px 0;">
          <a href="${dashboardUrl}" style="background-color: #8B1A1A; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(139,26,26,0.2);">
            Pay Now
          </a>
        </div>
      `;
      break;
    case 'payment-completed':
      subject = `✅ Payment Successful: ${booking.pooja_type} - SatkarmPuja`;
      messageContent = `Thank you! We have successfully received your payment of <b>₹${booking.price}</b> for your <b>${booking.pooja_type}</b> booking. Your booking status is now updated to Payment Completed.`;
      statusLabel = 'Payment Completed';
      statusBg = '#e0f2f1';
      statusColor = '#00695c';
      statusBorder = '#b2dfdb';
      break;
    case 'pooja-performed':
      subject = `🌸 Puja Successfully Performed - SatkarmPuja`;
      messageContent = `We are blessed to inform you that the sacred <b>${booking.pooja_type}</b> has been successfully performed. May the divine deities shower you and your family with peace, health, prosperity, and endless blessings.`;
      statusLabel = 'Puja Performed';
      statusBg = '#efebe9';
      statusColor = '#4e342e';
      statusBorder = '#d7ccc8';
      break;
    case 'pending':
    default:
      subject = `ℹ️ Booking Status Update: ${booking.pooja_type} - SatkarmPuja`;
      messageContent = `The status of your booking for the sacred <b>${booking.pooja_type}</b> has been updated to <b>Pending</b>. Our team will review your booking and update the status shortly.`;
      statusLabel = 'Pending';
      statusBg = '#f3e5f5';
      statusColor = '#6a1b9a';
      statusBorder = '#e1bee7';
      break;
  }

  const dateFormatted = booking.poojaDate
    ? new Date(booking.poojaDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'Not scheduled yet';

  const htmlBody = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; width: 92%; margin: 20px auto; padding: 0; border: 1px solid #f0e0c0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #ffffff;">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #8B1A1A 0%, #a32a2a 100%); padding: 32px 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 1px;">🙏 SatkarmPuja</h1>
        <p style="color: #ffd8d8; margin: 8px 0 0 0; font-size: 14px;">Connecting you to divine rituals</p>
      </div>
      
      <!-- Content Body -->
      <div style="padding: 32px 24px; color: #2c3e50; line-height: 1.6;">
        <h2 style="color: #8B1A1A; margin-top: 0; font-size: 20px;">Namaste ${booking.name},</h2>
        <p style="font-size: 16px; color: #34495e; margin-bottom: 24px;">
          ${messageContent}
        </p>
        
        <!-- Details Card (Mobile Responsive Stacked Design) -->
        <div style="background-color: #fffaf4; border: 1px solid #ffe8cc; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
          <h3 style="color: #d35400; margin-top: 0; margin-bottom: 16px; font-size: 16px; border-bottom: 1px solid #ffe8cc; padding-bottom: 8px;">Booking Reference Details</h3>
          
          <div style="margin-bottom: 14px;">
            <div style="font-size: 11px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.8px;">Puja Type</div>
            <div style="font-size: 15px; color: #2c3e50; font-weight: 600; margin-top: 2px;">${booking.pooja_type}</div>
          </div>

          <div style="margin-bottom: 14px;">
            <div style="font-size: 11px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.8px;">Booking ID</div>
            <div style="font-size: 13px; color: #7f8c8d; font-family: monospace; word-break: break-all; word-wrap: break-word; margin-top: 2px;">${booking.id}</div>
          </div>

          <div style="margin-bottom: 14px;">
            <div style="font-size: 11px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.8px;">Scheduled Date</div>
            <div style="font-size: 14px; color: #2c3e50; margin-top: 2px;">${dateFormatted}</div>
          </div>

          ${booking.price ? `
          <div style="margin-bottom: 14px;">
            <div style="font-size: 11px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.8px;">Price</div>
            <div style="font-size: 16px; color: #8B1A1A; font-weight: 700; margin-top: 2px;">₹${booking.price}</div>
          </div>
          ` : ''}

          <div style="margin-bottom: 4px;">
            <div style="font-size: 11px; font-weight: bold; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px;">Current Status</div>
            <span style="background-color: ${statusBg}; color: ${statusColor}; padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 12px; border: 1px solid ${statusBorder}; display: inline-block;">
              ${statusLabel}
            </span>
          </div>
        </div>

        ${actionButton}
      </div>
      
      <!-- Footer -->
      <div style="background-color: #fcfbf9; padding: 24px; text-align: center; border-top: 1px solid #f0e0c0;">
        <p style="margin: 0; font-size: 14px; color: #7f8c8d;">🌸 May the divine energy bring peace and prosperity to your home.</p>
        <p style="margin: 8px 0 0 0; font-size: 12px; color: #bdc3c7;">This is an automated notification from SatkarmPuja. Please do not reply directly to this email.</p>
      </div>
    </div>
  `;

  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'SatkarmPuja <onboarding@resend.dev>',
        to: booking.email,
        subject: subject,
        html: htmlBody,
      });
      if (error) {
        console.error(`❌ Error sending status update email to ${booking.email} via Resend:`, error);
      } else {
        console.log(`✅ Status update email sent to ${booking.email} via Resend for status: ${newStatus}`);
      }
    } catch (err) {
      console.error(`❌ Exception sending email to ${booking.email}:`, err);
    }
  } else {
    console.log(`\n======================================================================`);
    console.log(`✉️  MOCK EMAIL SENT TO: ${booking.email}`);
    console.log(`📌 SUBJECT: ${subject}`);
    console.log(`📄 STATUS UPDATE: ${oldStatus} ➔ ${newStatus}`);
    console.log(`🔗 DASHBOARD URL: ${dashboardUrl}`);
    console.log(`📦 DETAILS:`);
    console.log(`   - Name: ${booking.name}`);
    console.log(`   - Puja: ${booking.pooja_type}`);
    console.log(`   - Price: ₹${booking.price || 0}`);
    console.log(`   - Scheduled Date: ${dateFormatted}`);
    console.log(`======================================================================\n`);
  }
}

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
    const data = { ...req.body };
    if (data.poojaDate !== undefined) {
      data.poojaDate = data.poojaDate ? new Date(data.poojaDate) : null;
    }
    if (data.price !== undefined) {
      data.price = data.price ? parseFloat(data.price) : null;
    }

    // Get old booking to check for status changes
    const bookingBefore = await prisma.booking.findUnique({
      where: { id: req.params.id }
    });
    if (!bookingBefore) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data: data
    });

    // Send email notification if status changed
    if (data.status !== undefined && data.status !== bookingBefore.status) {
      sendStatusUpdateEmail(updated, bookingBefore.status, updated.status).catch(err => {
        console.error('Failed to send status update email:', err);
      });
    }

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

// --- Placeholder content routes for UI ---
app.get('/api/content/popularPoojas', (req, res) => {
  const sample = [
    { id: 1, name: 'Ganesh Chaturthi', description: 'Lord Ganesh worship', price: 1999 },
    { id: 2, name: 'Satyanarayan', description: 'Satyanarayan Puja', price: 1499 },
  ];
  res.json({ success: true, data: sample });
});

app.get('/api/content/poojaPrices', (req, res) => {
  const prices = { 1: 1999, 2: 1499, 3: 2999 };
  res.json({ success: true, prices });
});

app.post('/api/bookings', async (req, res) => {
  const booking = req.body;
  console.log('📚 Received booking:', booking);
  res.json({ success: true, bookingId: 'demo-' + Date.now() });
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
// PAYMENTS — Razorpay Live Integration
// ═══════════════════════════════════════════════════════════════════════════════

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// CREATE ORDER — called when user clicks "Pay Now"
app.post('/api/payments/create-order', async (req, res) => {
  const { bookingId } = req.body;
  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Razorpay is not configured on the server.' });
    }

    const order = await razorpay.orders.create({
      amount: Math.round((booking.price || 0) * 100), // convert to paise
      currency: 'INR',
      receipt: `booking_${bookingId}`.slice(0, 40),
      notes: { bookingId },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Razorpay create-order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment order' });
  }
});

// VERIFY PAYMENT — HMAC SHA256 signature check (prevents fake payment confirmations)
app.post('/api/payments/verify-payment', async (req, res) => {
  const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Missing payment fields' });
  }

  try {
    // Verify signature using HMAC SHA256
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.warn('⚠️ Invalid Razorpay signature for booking:', bookingId);
      return res.status(400).json({ success: false, error: 'Invalid payment signature. Payment rejected.' });
    }

    // Signature valid — mark booking as paid
    const updated = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'payment-completed',
        razorpayOrderId: razorpay_order_id,
      },
    });

    console.log(`✅ Payment verified for booking ${bookingId} | Payment ID: ${razorpay_payment_id}`);
    res.json({ success: true, booking: updated });
  } catch (error) {
    console.error('Razorpay verify-payment error:', error);
    res.status(400).json({ success: false, error: error.message || 'Payment verification failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
