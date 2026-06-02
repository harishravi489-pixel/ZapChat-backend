// routes/subscriptions.js
// ZapChat - Stripe + Razorpay subscription handling for Zap Rooms Pro ($2.99/month)
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Lazy-load payment SDKs so app starts even if keys aren't set yet
const getStripe = () => require('stripe')(process.env.STRIPE_SECRET_KEY);
const getRazorpay = () => {
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
};

const PRO_PRICE_USD = 2.99;
const PRO_PRICE_INR = 249; // ~$2.99 in INR

// ── GET /subscriptions/status ─────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('is_pro, pro_expires_at, sessions_created')
      .eq('id', req.user.id)
      .single();

    const isPro = user.is_pro && (!user.pro_expires_at || new Date(user.pro_expires_at) > new Date());
    const sessionsRemaining = Math.max(0, 2 - (user.sessions_created || 0));

    res.json({
      is_pro: isPro,
      sessions_created: user.sessions_created || 0,
      sessions_remaining: isPro ? 'unlimited' : sessionsRemaining,
      pro_expires_at: user.pro_expires_at,
      price: `$${PRO_PRICE_USD}/month`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscriptions/stripe/create-checkout ───────────────────────────────
router.post('/stripe/create-checkout', authMiddleware, async (req, res) => {
  try {
    const stripe = getStripe();
    const { data: user } = await supabase
      .from('users').select('email, stripe_customer_id').eq('id', req.user.id).single();

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: req.user.id } });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Zap Rooms Pro', description: 'Unlimited sessions, permanent rooms, 500 listeners' },
          unit_amount: Math.round(PRO_PRICE_USD * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      success_url: `${process.env.FRONTEND_URL}/rooms?upgrade=success`,
      cancel_url: `${process.env.FRONTEND_URL}/rooms?upgrade=cancelled`,
      metadata: { user_id: req.user.id }
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscriptions/stripe/webhook ───────────────────────────────────────
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const userId = event.data.object.metadata?.user_id;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded': {
      const sub = event.data.object;
      const periodEnd = new Date((sub.current_period_end || sub.subscription_details?.metadata?.period_end || Date.now() / 1000 + 30 * 86400) * 1000);

      if (userId) {
        await supabase.from('users').update({ is_pro: true, pro_expires_at: periodEnd.toISOString() }).eq('id', userId);
        await supabase.from('subscriptions').upsert({
          user_id: userId, provider: 'stripe',
          provider_subscription_id: sub.subscription || sub.id,
          status: 'active',
          amount: PRO_PRICE_USD, currency: 'USD',
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'provider_subscription_id' });
      }
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      if (userId) {
        await supabase.from('users').update({ is_pro: false }).eq('id', userId);
        await supabase.from('subscriptions')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('provider_subscription_id', event.data.object.id);
      }
      break;
    }
  }

  res.json({ received: true });
});

// ── POST /subscriptions/razorpay/create-order ─────────────────────────────────
router.post('/razorpay/create-order', authMiddleware, async (req, res) => {
  try {
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: PRO_PRICE_INR * 100, // paise
      currency: 'INR',
      receipt: `zapchat_${req.user.id}_${Date.now()}`,
      notes: { user_id: req.user.id }
    });

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscriptions/razorpay/verify ───────────────────────────────────────
router.post('/razorpay/verify', authMiddleware, async (req, res) => {
  try {
    const crypto = require('crypto');
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const proExpiry = new Date();
    proExpiry.setMonth(proExpiry.getMonth() + 1);

    await supabase.from('users').update({
      is_pro: true,
      pro_expires_at: proExpiry.toISOString(),
      razorpay_customer_id: razorpay_payment_id
    }).eq('id', req.user.id);

    await supabase.from('subscriptions').insert({
      user_id: req.user.id, provider: 'razorpay',
      provider_subscription_id: razorpay_payment_id,
      status: 'active', amount: PRO_PRICE_INR,
      currency: 'INR', current_period_end: proExpiry.toISOString()
    });

    res.json({ success: true, pro_expires_at: proExpiry.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscriptions/cancel ────────────────────────────────────────────────
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .single();

    if (!sub) return res.status(404).json({ error: 'No active subscription found.' });

    if (sub.provider === 'stripe') {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(sub.provider_subscription_id);
    }

    await supabase.from('subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    await supabase.from('users').update({ is_pro: false }).eq('id', req.user.id);

    res.json({ success: true, message: 'Subscription cancelled.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
